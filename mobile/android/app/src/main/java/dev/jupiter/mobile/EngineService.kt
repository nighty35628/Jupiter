package dev.jupiter.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Binder
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.system.Os
import android.system.OsConstants
import android.util.Base64
import dev.jupiter.mobile.runtime.BoundedLines
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.InputStreamReader
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/** Owns only the outer local host. Agent restarts remain the Node supervisor's job. */
class EngineService : Service() {
    data class Snapshot(val phase: String, val message: String, val runId: String? = null,
                        val url: String? = null, val active: Int = 0, val idleReady: Boolean = false)
    inner class LocalBinder : Binder() { fun service() = this@EngineService }
    private val main = Handler(Looper.getMainLooper())
    private val launcher = Executors.newSingleThreadExecutor()
    private val work = Executors.newSingleThreadExecutor()
    private val listeners = mutableSetOf<(Snapshot) -> Unit>()
    private val pending = ConcurrentHashMap<String, PendingRequest>()
    private val nativeWork = AtomicInteger()
    private val activeClients = mutableSetOf<Any>()
    private var idleSince: Long? = null
    private var idleCheckPending = false
    private var idleStop = false
    private val owner = AtomicReference<OwnedProcess?>()
    private val launchThread = AtomicReference<Thread?>()
    private val starting = AtomicBoolean(false)
    private val stopping = AtomicBoolean(false)
    private val writeLock = Any()
    private val stateLock = Any()
    @Volatile var snapshot = Snapshot("idle", "Local runtime stopped")
        private set
    @Volatile var paths: BundledRuntime.Paths? = null
        private set

    override fun onCreate() {
        super.onCreate()
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL, "Jupiter local runtime", NotificationManager.IMPORTANCE_LOW))
        enterForeground()
        main.postDelayed(idleCheck, 5000)
    }

    private fun enterForeground() {
        val notification = notification(snapshot.message)
        if (Build.VERSION.SDK_INT >= 34) startForeground(NOTIFICATION, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        else startForeground(NOTIFICATION, notification)
    }

    override fun onBind(intent: Intent?): IBinder = LocalBinder()
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == STOP) stopRuntime() else { enterForeground(); startRuntime() }
        return START_NOT_STICKY
    }

    fun observe(listener: (Snapshot) -> Unit) { listeners.add(listener); listener(snapshot) }
    fun unobserve(listener: (Snapshot) -> Unit) { listeners.remove(listener) }
    fun runWork(block: () -> Unit) {
        nativeWork.incrementAndGet()
        try { work.execute { try { block() } finally { nativeWork.decrementAndGet() } } }
        catch (error: RuntimeException) { nativeWork.decrementAndGet(); throw error }
    }

    fun setClientActive(client: Any, active: Boolean) {
        if (active) activeClients.add(client) else activeClients.remove(client)
        if (active) idleSince = null
    }

    private val idleCheck = object : Runnable {
        override fun run() {
            val state = snapshot
            if (state.phase == "ready" && state.idleReady && state.active == 0 &&
                activeClients.isEmpty() && nativeWork.get() == 0 && !stopping.get() && !idleCheckPending) {
                val now = android.os.SystemClock.elapsedRealtime()
                val since = idleSince ?: now.also { idleSince = it }
                if (now - since >= 60000) {
                    idleCheckPending = true
                    request("guarded_idle_stop") { response ->
                        idleCheckPending = false
                        if (!response.optBoolean("ok") || !response.optJSONObject("result").let { it?.optBoolean("stopped") == true })
                            idleSince = android.os.SystemClock.elapsedRealtime()
                    }
                }
            } else idleSince = null
            main.postDelayed(this, 5000)
        }
    }

    private fun publish(value: Snapshot) {
        synchronized(stateLock) {
            if (value.phase in setOf("preparing", "starting", "ready") && stopping.get()) return
            if (value.phase == "ready" && owner.get()?.runId != value.runId) return
            snapshot = value
        }
        main.post {
            val current = snapshot
            listeners.toList().forEach { it(current) }
            if (current.phase != "idle") getSystemService(NotificationManager::class.java).notify(NOTIFICATION, notification(current.message))
        }
    }

    private fun notification(message: String): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val stop = PendingIntent.getService(this, 1, Intent(this, EngineService::class.java).setAction(STOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        return Notification.Builder(this, CHANNEL).setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("Jupiter").setContentText(message).setContentIntent(open).setOngoing(true)
            .addAction(Notification.Action.Builder(null, "Stop", stop).build()).build()
    }

    private fun startRuntime() {
        if (owner.get() != null) { publish(snapshot); return }
        if (!starting.compareAndSet(false, true)) return
        stopping.set(false)
        idleStop = false
        idleSince = null
        launcher.execute {
            launchThread.set(Thread.currentThread())
            var process: Process? = null
            var owned: OwnedProcess? = null
            var secret: ByteArray? = null
            val uncertain = File(filesDir, "runtime-cleanup-uncertain")
            var markedLaunch = false
            try {
                if (uncertain.exists()) {
                    val others = File("/proc").listFiles()?.filter { it.name.all(Char::isDigit) && it.name != android.os.Process.myPid().toString() }
                        ?: error("Cannot verify prior runtime cleanup")
                    if (others.any { entry -> runCatching { File(entry, "status").readText().contains("Uid:\t${android.os.Process.myUid()}\t") }.getOrDefault(false) }) {
                        publish(Snapshot("fault", "A previous runtime may still be running. Force-stop Jupiter in Android app settings before reopening. Saved data was kept."))
                        return@execute
                    }
                    if (!uncertain.delete()) error("Cannot clear prior cleanup marker")
                }
                publish(Snapshot("preparing", "Preparing bundled runtime"))
                val prepared = BundledRuntime.prepare(this) { publish(Snapshot("preparing", it)) }
                paths = prepared
                if (stopping.get()) return@execute
                val dek = try { ConfigKeyStore(this).loadOrCreate(File(prepared.home, ".jupiter/config.json").exists()) }
                catch (_: Exception) {
                    publish(Snapshot("fault", "Saved configuration could not be unlocked. No saved data was reset."))
                    return@execute
                }
                secret = dek
                val runId = UUID.randomUUID().toString()
                val builder = BundledRuntime.processBuilder(prepared)
                val wrapped = mutableListOf("/system/bin/sh", "-c", "printf 'JUPITER_PROOT_PID %s\\n' \"\$\$\"; exec \"\$@\"", "jupiter-local")
                wrapped.addAll(builder.command()); builder.command(wrapped)
                if (stopping.get() || Thread.currentThread().isInterrupted) throw InterruptedException()
                publish(Snapshot("starting", "Starting local runtime", runId))
                FileOutputStream(uncertain).use { it.write("Runtime cleanup must be verified before another launch.\n".toByteArray()); it.fd.sync() }
                markedLaunch = true
                process = builder.start()
                owned = OwnedProcess(process, runId)
                owner.set(owned)
                val current = owned
                main.postDelayed({
                    if (owner.get() === current && !current.ready.get() && !stopping.get()) {
                        publish(Snapshot("fault", "Local runtime startup timed out"))
                        Thread({ terminateOwned(current) }, "jupiter-startup-timeout").start()
                    }
                }, 60000)
                val stderr = Thread({
                    InputStreamReader(current.process.errorStream).use { input ->
                        val lines = BoundedLines(input, 8192)
                        while (lines.next() != null) { /* Drain diagnostics; never log raw provider/config data. */ }
                    }
                }, "jupiter-stderr").apply { isDaemon = true; start() }
                try {
                    InputStreamReader(process.inputStream).use { input ->
                        val lines = BoundedLines(input, 1024 * 1024)
                        val first = lines.next() ?: error("Local launcher did not return an identity")
                        if (first.truncated || !first.text.matches(Regex("JUPITER_PROOT_PID [0-9]+"))) error("Invalid local launcher identity")
                        current.pid = first.text.substringAfter(' ').toInt()
                        current.startTime = processStartTime(current.pid)
                        requireOwned(current)
                        current.identified.countDown()
                        if (stopping.get()) throw InterruptedException()
                        val frame = JSONObject().put("type", "android-bootstrap").put("version", 1).put("role", "host")
                            .put("runId", runId).put("configPath", "/home/jupiter/.jupiter/config.json")
                            .put("dek", Base64.encodeToString(dek, Base64.NO_WRAP)).toString().toByteArray(Charsets.UTF_8)
                        try { synchronized(writeLock) { process.outputStream.write(frame); process.outputStream.write(10); process.outputStream.flush() } }
                        finally { frame.fill(0); dek.fill(0) }
                        while (true) {
                            val line = lines.next() ?: break
                            if (line.truncated) error("Local host response exceeded its limit")
                            val packet = JSONObject(line.text)
                            if (packet.optInt("version") != 1 || packet.optString("runId") != runId) error("Stale local host response")
                            when (packet.optString("type")) {
                                "android-ready" -> {
                                    if (!current.ready.compareAndSet(false, true)) error("Duplicate local host readiness")
                                    val url = packet.getString("url")
                                    val uri = android.net.Uri.parse(url)
                                    if (uri.scheme != "http" || uri.host != "127.0.0.1" || uri.port !in 1..65535 || uri.path != "/" || uri.userInfo != null)
                                        error("Invalid local host origin")
                                    publish(Snapshot("ready", "Local runtime ready", runId, url))
                                }
                                "android-activity" -> {
                                    val active = packet.optInt("active").coerceAtLeast(0)
                                    publish(snapshot.copy(active = active, idleReady = packet.optBoolean("idleReady") && active == 0,
                                        message = if (active > 0) "Working locally" else "Local runtime ready"))
                                }
                                "android-result" -> pending.remove(packet.optString("requestId"))?.let { request ->
                                    if (request.command == "guarded_idle_stop" && packet.optBoolean("ok") &&
                                        packet.optJSONObject("result")?.optBoolean("stopped") == true) {
                                        idleStop = true; stopping.set(true)
                                        publish(snapshot.copy(phase = "stopping", message = "Pausing idle runtime", idleReady = false))
                                    }
                                    main.post { request.callback(packet) }
                                }
                                else -> error("Unsupported local host response")
                            }
                        }
                    }
                } finally { dek.fill(0); current.identified.countDown() }
                if (!process.waitFor(5, TimeUnit.SECONDS)) error("Local host did not exit")
                stderr.join(1000)
                if (!stopping.get()) publish(Snapshot("fault", "Local runtime stopped. Reopen it to continue; unfinished actions were not replayed."))
            } catch (error: Exception) {
                // Log locations and exception classes only, never arbitrary error messages or streams.
                android.util.Log.e("JupiterRuntime", "${snapshot.phase}: ${error.javaClass.simpleName} at ${error.stackTrace.firstOrNull { it.className.startsWith("dev.jupiter.mobile") }}")
                if (!stopping.get()) publish(Snapshot("fault", "Local runtime could not start or stopped unexpectedly. Saved projects were kept."))
            } finally {
                secret?.fill(0)
                if (owned != null) terminateOwned(owned)
                else if (process?.isAlive == true) process.destroyForcibly()
                if (markedLaunch && (owned?.cleaned?.get() == true || process == null)) {
                    if (!uncertain.delete() && uncertain.exists())
                        android.util.Log.e("JupiterRuntime", "Could not clear completed runtime ownership marker")
                }
                owner.set(null); starting.set(false); launchThread.set(null)
                pending.values.toList().forEach { request -> main.post { request.callback(JSONObject().put("ok", false).put("error", "Local runtime disconnected")) } }
                pending.clear()
                val wasStopped = stopping.get()
                main.post {
                    if (owner.get() == null && !starting.get()) {
                        if (wasStopped) publish(Snapshot("idle", "Local runtime stopped"))
                        if (idleStop && activeClients.isNotEmpty()) { enterForeground(); startRuntime() }
                        else { stopForeground(STOP_FOREGROUND_REMOVE); stopSelf() }
                    }
                }
            }
        }
    }

    fun request(command: String, args: JSONObject = JSONObject(), callback: (JSONObject) -> Unit) {
        val current = owner.get()
        if (current == null || snapshot.phase != "ready" || stopping.get() || pending.size >= 16) {
            callback(JSONObject().put("ok", false).put("error", "Local runtime is not ready")); return
        }
        val requestId = UUID.randomUUID().toString()
        pending[requestId] = PendingRequest(command, callback)
        work.execute {
            try {
                val frame = JSONObject(args.toString()).put("type", "android-control").put("version", 1)
                    .put("runId", current.runId).put("requestId", requestId).put("command", command).toString()
                if (frame.toByteArray(Charsets.UTF_8).size > 8192) error("Host request exceeded its limit")
                synchronized(writeLock) { current.process.outputStream.write((frame + "\n").toByteArray(Charsets.UTF_8)); current.process.outputStream.flush() }
            } catch (_: Exception) { pending.remove(requestId)?.let { request -> main.post { request.callback(JSONObject().put("ok", false).put("error", "Local host request failed")) } } }
        }
    }

    fun stopRuntime() {
        if (!stopping.compareAndSet(false, true)) return
        publish(snapshot.copy(phase = "stopping", message = "Stopping local runtime"))
        val current = owner.get()
        if (current == null && starting.get()) launchThread.get()?.interrupt()
        if (current == null && !starting.get()) { publish(Snapshot("idle", "Local runtime stopped")); stopForeground(STOP_FOREGROUND_REMOVE); stopSelf(); return }
        Thread({
            if (current != null) {
                try {
                    val message = JSONObject().put("type", "android-control").put("version", 1).put("runId", current.runId).put("command", "stop")
                    synchronized(writeLock) { current.process.outputStream.write((message.toString() + "\n").toByteArray(Charsets.UTF_8)); current.process.outputStream.flush() }
                } catch (_: Exception) { /* Escalation below still owns cleanup. */ }
                if (!current.process.waitFor(5, TimeUnit.SECONDS)) terminateOwned(current)
            }
        }, "jupiter-stop").start()
    }

    private fun terminateOwned(current: OwnedProcess) = synchronized(current) {
        if (current.cleanupAttempted) return
        current.cleanupAttempted = true
        if (!current.process.isAlive) { current.cleaned.set(current.process.exitValue() == 0); return }
        val interrupted = Thread.interrupted()
        var graceful = false
        try {
            current.identified.await(3, TimeUnit.SECONDS)
            requireOwned(current)
            Os.kill(current.pid, OsConstants.SIGQUIT)
            graceful = true
        } catch (_: Exception) { /* Never signal a PID whose identity cannot be verified. */ }
        finally {
            try {
                if (!current.process.waitFor(3, TimeUnit.SECONDS)) { graceful = false; current.process.destroyForcibly() }
                if (!current.process.waitFor(3, TimeUnit.SECONDS)) graceful = false
            } catch (_: InterruptedException) { graceful = false; current.process.destroyForcibly(); Thread.currentThread().interrupt() }
            if (!graceful) runCatching { File(filesDir, "runtime-cleanup-uncertain").writeText("Stop Jupiter from Android settings before retrying.") }
            if (graceful && !current.process.isAlive) current.cleaned.set(true)
            if (interrupted) Thread.currentThread().interrupt()
        }
    }

    private fun requireOwned(value: OwnedProcess) {
        if (value.pid <= 0 || value.startTime.isEmpty() || processStartTime(value.pid) != value.startTime) error("Process identity changed")
        if (!File("/proc/${value.pid}/status").readText().contains("Uid:\t${android.os.Process.myUid()}\t")) error("Process owner changed")
    }
    private fun processStartTime(pid: Int): String {
        val text = File("/proc/$pid/stat").readText()
        return text.substring(text.lastIndexOf(')') + 2).split(' ')[19]
    }

    override fun onDestroy() { main.removeCallbacks(idleCheck); activeClients.clear(); stopRuntime(); work.shutdown(); launcher.shutdown(); super.onDestroy() }

    private data class PendingRequest(val command: String, val callback: (JSONObject) -> Unit)

    private class OwnedProcess(val process: Process, val runId: String) {
        @Volatile var pid = 0
        @Volatile var startTime = ""
        val identified = CountDownLatch(1)
        val ready = AtomicBoolean(false)
        val cleaned = AtomicBoolean(false)
        var cleanupAttempted = false
    }
    companion object { const val STOP = "dev.jupiter.mobile.STOP"; private const val CHANNEL = "jupiter-runtime"; private const val NOTIFICATION = 41 }
}
