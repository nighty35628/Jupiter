package dev.jupiter.mobile

import android.app.AlertDialog
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.ComponentName
import android.content.BroadcastReceiver
import android.content.Context
import android.content.IntentFilter
import android.content.ClipData
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import android.provider.MediaStore
import android.provider.Settings
import android.view.Gravity
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.core.content.FileProvider
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import androidx.webkit.WebMessageCompat
import org.json.JSONObject
import org.json.JSONArray
import java.io.ByteArrayInputStream
import java.io.Closeable
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

class MainActivity : ComponentActivity() {
    private lateinit var root: FrameLayout
    @Volatile private var engine: EngineService? = null
    @Volatile private var web: WebView? = null
    @Volatile private var loadedRun: String? = null
    @Volatile private var workbenchAuthorization: RunAuthorization? = null
    private var deferredShareNotification: RunAuthorization? = null
    private var origin = ""
    private var bound = false
    private var clientStarted = false
    private var speechResumed = false
    private val speechHost = AndroidSpeechHost(this) { speechResumed }
    private val speech = SpeechSessionController(speechHost)
    private val speechLockReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) { speech.cancelCurrent() }
    }
    private var shareIntakePending = false
    private var shareIntakeJobs = 0
    private val inFlight = mutableSetOf<String>()
    private val completed = linkedMapOf<String, String>()
    private var fileChooser: ValueCallback<Array<Uri>>? = null
        set(value) { field = value; updateClientActivity() }
    @Volatile private var fileOperation: FileOperation? = null
        set(value) { field = value; updateClientActivity() }
    private var download: Download? = null
    private var notificationReply: ((JSONObject) -> Unit)? = null
        set(value) { field = value; updateClientActivity() }
    private val cancelled = AtomicBoolean(false)
    private val shares by lazy { NativeShareStore(File(cacheDir.canonicalFile, "native-shares")) }
    @Volatile private var consumedShare: ConsumedShare? = null
    private var intakeToken: String? = null
    private val pageCaptures = mutableSetOf<File>()
    private val observer: (EngineService.Snapshot) -> Unit = {
        if (!cancelled.get()) {
            val state = engine?.snapshot
            if (state?.phase == "ready" && state.url != null && state.runId != null) {
                if (loadedRun != state.runId || web == null) showWorkbench(state.url, state.runId)
            } else showStatus(state?.message ?: "Local runtime disconnected", state == null || state.phase == "fault" || state.phase == "idle")
        }
    }
    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, binder: IBinder) {
            val service = (binder as EngineService.LocalBinder).service()
            if (cancelled.get()) { service.setClientActive(this@MainActivity, false); return }
            engine?.takeIf { it !== service }?.let { previous ->
                previous.setClientActive(this@MainActivity, false); previous.unobserve(observer)
            }
            engine = service
            updateClientActivity()
            service.observe(observer)
            if (clientStarted && service.snapshot.phase == "idle") startLocalRuntime()
        }
        override fun onServiceDisconnected(name: ComponentName) {
            engine?.setClientActive(this@MainActivity, false)
            engine?.unobserve(observer)
            engine = null
            if (!cancelled.get()) showStatus("Local runtime disconnected", true)
        }
    }

    override fun onCreate(saved: Bundle?) {
        super.onCreate(saved)
        ContextCompat.registerReceiver(this, speechLockReceiver, IntentFilter(Intent.ACTION_SCREEN_OFF), ContextCompat.RECEIVER_NOT_EXPORTED)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        root = FrameLayout(this)
        setContentView(root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, keyboard.bottom))
            insets
        }
        val light = resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK != Configuration.UI_MODE_NIGHT_YES
        WindowCompat.getInsetsController(window, root).apply {
            isAppearanceLightStatusBars = light; isAppearanceLightNavigationBars = light
        }
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = handleBack()
        })
        intakeToken = saved?.getString(SHARE_INTAKE_TOKEN)
        receiveShare(intent)
        refreshShareIntakePending()
        saved?.getStringArrayList(CAPTURE_FILES)?.forEach { name ->
            if (CAPTURE_NAME.matches(name)) discardCapture(File(File(cacheDir, "captures"), name))
        }
        startLocalRuntime()
        bound = bindService(Intent(this, EngineService::class.java), connection, BIND_AUTO_CREATE)
    }

    override fun onNewIntent(incoming: Intent) {
        super.onNewIntent(incoming)
        if (cancelled.get()) return
        // Tokens supplied by other apps are never trusted as native intake identities.
        intakeToken = null
        setIntent(incoming)
        receiveShare(incoming)
        notifyShareAvailable()
    }

    override fun onSaveInstanceState(saved: Bundle) {
        saved.putString(SHARE_INTAKE_TOKEN, intakeToken)
        val captures = pageCaptures.map { it.name } + listOfNotNull(fileOperation?.capture?.file?.name)
        saved.putStringArrayList(CAPTURE_FILES, ArrayList(captures))
        super.onSaveInstanceState(saved)
    }

    override fun onResume() {
        super.onResume()
        speechResumed = true
        speech.onResume()
        notifyShareAvailable()
    }

    override fun onPause() {
        speechResumed = false
        speech.onPause()
        super.onPause()
    }

    override fun onStart() {
        super.onStart()
        if (cancelled.get()) return
        clientStarted = true
        updateClientActivity()
        if (engine?.snapshot?.phase == "idle") startLocalRuntime()
    }

    override fun onStop() {
        speech.cancelCurrent()
        clientStarted = false
        updateClientActivity()
        super.onStop()
    }

    private fun updateClientActivity() {
        engine?.setClientActive(this, !cancelled.get() &&
            (clientStarted || pickerBusy() || fileChooser != null || notificationReply != null || shareIntakePending))
    }

    private fun refreshShareIntakePending() {
        // Durable queued shares are not active work; staging IO is covered by fileOperation.
        shareIntakePending = shareIntakeJobs > 0 && !cancelled.get()
        updateClientActivity()
    }

    private fun startLocalRuntime() {
        if (cancelled.get()) return
        val state = engine?.snapshot
        if (state?.phase == "ready" && state.url != null && state.runId != null) { showWorkbench(state.url, state.runId); return }
        showStatus("Preparing Jupiter", false)
        startForegroundService(Intent(this, EngineService::class.java))
    }

    private fun showStatus(message: String, retry: Boolean) {
        revokeWorkbench()
        val panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER; setPadding(32, 32, 32, 32)
            addView(TextView(context).apply { text = "Jupiter"; textSize = 24f; gravity = Gravity.CENTER })
            if (!retry) addView(ProgressBar(context), LinearLayout.LayoutParams(64, 64).apply { topMargin = 24 })
            addView(TextView(context).apply { text = message; textSize = 15f; gravity = Gravity.CENTER }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 24 })
            if (retry) addView(Button(context).apply { text = "Retry"; setOnClickListener { startLocalRuntime() } })
        }
        root.removeAllViews(); root.addView(panel, FrameLayout.LayoutParams(-1, -1))
    }

    private fun showWorkbench(url: String, runId: String) {
        val address = Uri.parse(url)
        if (address.scheme != "http" || address.host != "127.0.0.1" || address.port !in 1..65535) {
            showStatus("Invalid local runtime origin", true); return
        }
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            showStatus("Update Android System WebView before opening Jupiter", true); return
        }
        revokeWorkbench()
        loadedRun = runId
        val authorization = RunAuthorization(runId)
        workbenchAuthorization = authorization
        inFlight.clear(); completed.clear()
        origin = "http://127.0.0.1:${address.port}"
        val view = WebView(this)
        web = view
        view.settings.apply {
            javaScriptEnabled = true; domStorageEnabled = true
            allowFileAccess = false; allowContentAccess = true
            setSupportMultipleWindows(false); javaScriptCanOpenWindowsAutomatically = false
            mediaPlaybackRequiresUserGesture = true; setGeolocationEnabled(false)
        }
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, false)
        WebViewCompat.addWebMessageListener(view, "JupiterAndroid", setOf(origin)) { source, message, sourceOrigin, mainFrame, proxy ->
            if (!mainFrame || sourceOrigin.toString() != origin || !canUseWorkbench(source, authorization) || source.url?.let { Uri.parse(it).path } != "/") return@addWebMessageListener
            if (message.type != WebMessageCompat.TYPE_STRING) return@addWebMessageListener
            try {
                val raw = message.data ?: return@addWebMessageListener
                if (raw.length > 8192 || raw.toByteArray(Charsets.UTF_8).size > 8192) return@addWebMessageListener
                val request = JSONObject(raw)
                val id = request.getString("requestId")
                if (!UUID_PATTERN.matches(id) || request.optInt("version") != 1 || request.optString("runId") != runId) return@addWebMessageListener
                completed[id]?.let { proxy.postMessage(it); return@addWebMessageListener }
                if (inFlight.size >= 16 || !inFlight.add(id)) return@addWebMessageListener
                val reply: (JSONObject) -> Unit = { result ->
                    if (canUseWorkbench(source, authorization) && inFlight.remove(id)) {
                        val response = result.put("requestId", id).put("runId", runId).toString()
                        completed[id] = response
                        if (completed.size > 128) completed.remove(completed.keys.first())
                        proxy.postMessage(response)
                    }
                }
                try {
                    val command = request.optString("command")
                    val args = request.optJSONObject("args") ?: JSONObject()
                    if (command in setOf("speechCapabilities", "speechStart", "speechFinish", "speechCancel")) {
                        dispatchSpeech(command, args, { canUseSpeechPage(source, authorization) }, { event ->
                            if (canUseSpeechPage(source, authorization)) {
                                val payload = JSONObject().put("sessionId", event.sessionId).put("state", event.state)
                                event.text?.let { payload.put("text", it) }
                                event.error?.let { payload.put("error", it) }
                                // Speech is a separate envelope, never a second invocation of the one-shot reply.
                                proxy.postMessage(JSONObject().put("type", "speech").put("runId", runId).put("event", payload).toString())
                            }
                        }, reply)
                    } else dispatchBridge(command, args, reply)
                } catch (_: Exception) { reply(failure("Native operation could not start")) }
            } catch (_: Exception) { /* Malformed requests receive no native capability. */ }
        }
        view.webViewClient = object : WebViewClient() {
            override fun onPageStarted(current: WebView, page: String, favicon: android.graphics.Bitmap?) {
                if (web === current) speech.cancelCurrent()
            }
            override fun shouldOverrideUrlLoading(current: WebView, request: WebResourceRequest): Boolean {
                if (!canUseWorkbench(current, authorization)) return true
                val target = request.url
                val local = target.scheme == "http" && target.host == "127.0.0.1" && target.port == address.port
                if (local && (!request.isForMainFrame || target.path == "/")) return false
                if (request.isForMainFrame && request.hasGesture()) openExternal(target)
                return true
            }
            override fun shouldInterceptRequest(current: WebView, request: WebResourceRequest): WebResourceResponse? =
                interceptShare(current, authorization, request)
            override fun onPageFinished(current: WebView, page: String) {
                CookieManager.getInstance().flush()
                if (canUseWorkbench(current, authorization)) notifyShareAvailable()
            }
            override fun onRenderProcessGone(current: WebView, detail: RenderProcessGoneDetail): Boolean {
                if (web === current) showStatus("The page stopped. Reopen it to reconnect; no action will be replayed.", true)
                return true
            }
        }
        view.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(current: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                if (!canUseWorkbench(current, authorization)) { callback.onReceiveValue(null); return true }
                val operation = beginFileOperation { } ?: run { callback.onReceiveValue(null); return true }
                fileChooser = callback
                try {
                    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
                        .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.mode == FileChooserParams.MODE_OPEN_MULTIPLE)
                    val mime = params.acceptTypes.filter { it.contains('/') && !it.contains(',') }.toTypedArray()
                    if (mime.isNotEmpty()) intent.putExtra(Intent.EXTRA_MIME_TYPES, mime)
                    val chooser = if (NativeShareStore.acceptsCamera(params.acceptTypes.toList())) cameraChooser(operation, intent) else intent
                    launchPicker(operation, chooser, PICK_FILES)
                } catch (_: Exception) { finishFileOperation(operation, failure("File dialog could not be opened")) }
                return true
            }
            override fun onPermissionRequest(request: android.webkit.PermissionRequest) { request.deny() }
        }
        view.setDownloadListener { target, _, disposition, _, _ ->
            val uri = Uri.parse(target)
            val id = uri.path?.removePrefix("/api/files/") ?: ""
            if (canUseWorkbench(view, authorization) && uri.scheme == "http" && uri.host == "127.0.0.1" && uri.port == address.port && UUID_PATTERN.matches(id)) {
                beginDownload(id, "jupiter-export", { })
            }
        }
        root.removeAllViews(); root.addView(view, FrameLayout.LayoutParams(-1, -1))
        view.loadUrl(url)
    }

    private fun canUseWorkbench(source: WebView, authorization: RunAuthorization): Boolean {
        val state = engine?.snapshot
        return source === web && workbenchAuthorization === authorization && !isDestroyed &&
            authorization.permits(loadedRun, state?.phase, state?.runId)
    }

    private fun canUseSpeechPage(source: WebView, authorization: RunAuthorization): Boolean {
        if (!canUseWorkbench(source, authorization) || cancelled.get()) return false
        val url = source.url?.let(Uri::parse) ?: return false
        return url.scheme == "http" && "${url.scheme}://${url.host}:${url.port}" == origin && url.path == "/"
    }

    private fun dispatchSpeech(command: String, args: JSONObject, authorized: () -> Boolean,
                               emit: (SpeechEvent) -> Unit, reply: (JSONObject) -> Unit) {
        if (command == "speechCapabilities") {
            val capability = speechHost.capabilities()
            reply(JSONObject().put("ok", true).put("result", JSONObject().put("available", capability.available)
                .put("backend", "android").put("localAvailable", capability.localAvailable)
                .put("networkAvailable", capability.networkAvailable).put("autoLanguage", false)
                .put("modelReady", true).put("modelBytes", 0)))
            return
        }
        val id = args.opt("sessionId") as? String
        if (id == null || !SpeechSessionController.validSessionId(id)) { reply(failure("Invalid speech session ID")); return }
        when (command) {
            "speechStart" -> {
                if (pickerBusy() || notificationReply != null) { reply(failure("Another native dialog is pending")); return }
                val error = speech.start(id, args.opt("language") as? String ?: "", args.opt("mode") as? String ?: "", authorized, emit)
                reply(if (error == null) JSONObject().put("ok", true).put("result", true) else failure(error))
            }
            "speechFinish" -> reply(JSONObject().put("ok", true).put("result", speech.finish(id)))
            "speechCancel" -> reply(JSONObject().put("ok", true).put("result", speech.cancel(id)))
        }
    }

    private fun replaceShareIntent() {
        setIntent(Intent(this, MainActivity::class.java).setAction(Intent.ACTION_MAIN).setIdentifier(intakeToken))
    }

    @Suppress("DEPRECATION")
    private fun receiveShare(incoming: Intent) {
        if (cancelled.get() || incoming.action !in listOf(Intent.ACTION_SEND, Intent.ACTION_SEND_MULTIPLE)) return
        try {
            val streams = if (incoming.action == Intent.ACTION_SEND_MULTIPLE)
                incoming.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)?.toList() ?: emptyList()
            else listOfNotNull(incoming.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))
            val clip = incoming.clipData
            require(streams.size <= NativeShareStore.MAX_FILES && (clip?.itemCount ?: 0) <= NativeShareStore.MAX_FILES)
            val uris = (streams + (0 until (clip?.itemCount ?: 0)).mapNotNull { clip?.getItemAt(it)?.uri })
                .map { it.toString() }.distinct()
            require(uris.size <= NativeShareStore.MAX_FILES && uris.all(NativeShareStore::isContentUri))
            val text = NativeShareStore.boundText(incoming.getCharSequenceExtra(Intent.EXTRA_TEXT)
                ?: clip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.text)
            val token = intakeToken ?: UUID.randomUUID().toString()
            intakeToken = token
            val mime = NativeShareStore.mimeType(incoming.type)
            shareIntakeJobs++; refreshShareIntakePending()
            try {
                NativeShareStore.executeMetadata {
                    val accepted = runCatching { shares.enqueue(token, text, uris, mime) }.isSuccess
                    runOnUiThread {
                        shareIntakeJobs--; refreshShareIntakePending()
                        if (!cancelled.get()) {
                            if (accepted) {
                                // Retain the original intent until the journal commit, including across recreation.
                                if (intakeToken == token) replaceShareIntent()
                                notifyShareAvailable()
                            } else Toast.makeText(this, "Share could not be received. Existing pending shares were kept.", Toast.LENGTH_LONG).show()
                        }
                    }
                }
            } catch (failure: Exception) { shareIntakeJobs--; refreshShareIntakePending(); throw failure }
        } catch (_: Exception) {
            Toast.makeText(this, "Share could not be received or the queue is full. Existing pending shares were kept.", Toast.LENGTH_LONG).show()
        } finally { refreshShareIntakePending() }
    }

    private fun notifyShareAvailable() {
        val current = web ?: return
        val authorization = workbenchAuthorization ?: return
        if (canUseWorkbench(current, authorization)) current.evaluateJavascript("window.dispatchEvent(new Event('jupiter:android-share-ready'))", null)
    }

    private fun consumeShare(reply: (JSONObject) -> Unit) {
        val pageAuthorization = workbenchAuthorization ?: run { reply(failure("Local runtime is not ready")); return }
        val source = web ?: run { reply(failure("Local runtime is not ready")); return }
        try {
            NativeShareStore.executeMetadata {
                val pending = runCatching { shares.first() != null }
                runOnUiThread {
                    if (!canUseWorkbench(source, pageAuthorization)) { reply(failure("Local runtime changed")); return@runOnUiThread }
                    if (pending.isFailure) { reply(failure("Share could not be checked; it remains pending")); return@runOnUiThread }
                    if (!pending.getOrThrow()) { reply(JSONObject().put("ok", true).put("result", JSONObject.NULL)); return@runOnUiThread }
                    if (pickerBusy()) {
                        deferredShareNotification = pageAuthorization
                        reply(JSONObject().put("ok", true).put("result", JSONObject.NULL))
                    } else consumePendingShare(pageAuthorization, reply)
                }
            }
        } catch (_: Exception) { reply(failure("Share check is busy; it remains pending")) }
    }

    private fun consumePendingShare(pageAuthorization: RunAuthorization, reply: (JSONObject) -> Unit) {
        val operation = beginFileOperation(reply) ?: return
        val shareOrigin = origin
        operation.ioRunning = true
        try {
            operation.service.runWork {
                var staged: NativeShareStore.Share? = null
                val response = try {
                    requireFileOperation(operation)
                    val pending = shares.first()
                    if (pending == null) JSONObject().put("ok", true).put("result", JSONObject.NULL)
                    else {
                        staged = shares.stage(pending.id, { value ->
                            requireFileOperation(operation)
                            val uri = Uri.parse(value)
                            val name = contentName(uri)
                            val mime = runCatching { contentResolver.getType(uri) }.getOrNull() ?: pending.mime
                            requireFileOperation(operation)
                            val input = contentResolver.openInputStream(uri) ?: error("Shared file is unavailable")
                            operation.input = input
                            NativeShareStore.Source(name, mime, input)
                        }, { fileOperationAllowed(operation) })
                        val share = staged!!
                        val files = JSONArray()
                        share.files.forEach { file ->
                            files.put(JSONObject().put("id", file.id).put("name", file.name).put("mime", file.mime)
                                .put("size", file.size).put("url", "$shareOrigin/native-share/${file.id}"))
                        }
                        JSONObject().put("ok", true).put("result", JSONObject().put("id", share.id).put("text", share.text).put("files", files))
                    }
                } catch (_: Exception) { failure("Share could not be opened. It remains pending; try again or share it again.") }
                finally { operation.input = null }
                runOnUiThread {
                    refreshShareIntakePending()
                    if (fileOperationAllowed(operation)) {
                        if (response.optBoolean("ok")) {
                            val previous = consumedShare
                            // Duplicate wakeups must not revoke a file stream already being read.
                            if (previous?.share != staged || previous?.authorization !== pageAuthorization || previous?.origin != shareOrigin) {
                                consumedShare = staged?.let { ConsumedShare(it, pageAuthorization, shareOrigin) }
                            }
                        }
                        finishFileOperation(operation, response)
                    } else finishFileOperation(operation, failure("Local runtime changed; share remains pending"))
                }
            }
        } catch (_: Exception) { finishFileOperation(operation, failure("Share could not be opened; it remains pending")) }
    }

    private fun acknowledgeShare(id: String, reply: (JSONObject) -> Unit) {
        val consumed = consumedShare
        val current = web
        if (consumed == null || id != consumed.share.id || current == null || !canUseWorkbench(current, consumed.authorization)) {
            reply(failure("Share was not consumed by this page")); return
        }
        val operation = beginFileOperation(reply) ?: return
        operation.ioRunning = true
        consumedShare = null
        try {
            operation.service.runWork {
                val response = try {
                    shares.acknowledge(consumed.share, id) { fileOperationAllowed(operation) }
                    JSONObject().put("ok", true).put("result", true)
                } catch (_: Exception) { failure("Share acknowledgement did not complete; try again") }
                runOnUiThread {
                    refreshShareIntakePending()
                    if (!response.optBoolean("ok") && fileOperationAllowed(operation)) consumedShare = consumed
                    finishFileOperation(operation, response, notifyShare = response.optBoolean("ok"))
                }
            }
        } catch (_: Exception) {
            if (fileOperationAllowed(operation)) consumedShare = consumed
            finishFileOperation(operation, failure("Share acknowledgement could not start"))
        }
    }

    private fun discardShare(expectedId: String?, reply: (JSONObject) -> Unit) {
        if (expectedId != null && !NativeShareStore.isId(expectedId)) { reply(failure("Invalid share identity")); return }
        val operation = beginFileOperation(reply) ?: return
        operation.ioRunning = true
        try {
            operation.service.runWork {
                try {
                    requireFileOperation(operation)
                    val head = shares.first()
                    runOnUiThread {
                        operation.ioRunning = false
                        if (!fileOperationAllowed(operation)) { finishFileOperation(operation, failure("Local runtime changed")); return@runOnUiThread }
                        if (head == null || (expectedId != null && expectedId != head.id)) {
                            finishFileOperation(operation, discardResult(false)); return@runOnUiThread
                        }
                        try {
                            operation.dialog = AlertDialog.Builder(this).setTitle("Discard pending share?")
                                .setMessage("Only Jupiter's local copy will be removed. Original files will be kept.")
                                .setPositiveButton("Discard") { _, _ -> discardConfirmedShare(operation, head.id) }
                                .setNegativeButton("Cancel") { _, _ -> finishFileOperation(operation, discardResult(false)) }
                                .setOnCancelListener { finishFileOperation(operation, discardResult(false)) }.create()
                            operation.dialog?.show()
                        } catch (_: Exception) { finishFileOperation(operation, failure("Share confirmation could not be opened")) }
                    }
                } catch (_: Exception) {
                    runOnUiThread { finishFileOperation(operation, failure("Pending share could not be checked; nothing was discarded")) }
                }
            }
        } catch (_: Exception) { finishFileOperation(operation, failure("Share discard could not start")) }
    }

    private fun discardConfirmedShare(operation: FileOperation, headId: String) {
        if (!fileOperationAllowed(operation)) { finishFileOperation(operation, failure("Local runtime changed")); return }
        operation.ioRunning = true
        operation.dialog?.dismiss(); operation.dialog = null
        val previous = consumedShare?.takeIf { it.share.id == headId }
        if (previous != null) consumedShare = null
        try {
            operation.service.runWork {
                val response = try {
                    discardResult(shares.discard(headId) { fileOperationAllowed(operation) })
                } catch (_: Exception) { failure("Share discard did not complete; the pending entry was kept") }
                runOnUiThread {
                    refreshShareIntakePending()
                    val discarded = response.optBoolean("ok") && response.optJSONObject("result")?.optBoolean("discarded") == true
                    if (!discarded && previous != null && fileOperationAllowed(operation)) consumedShare = previous
                    finishFileOperation(operation, response, notifyShare = discarded)
                }
            }
        } catch (_: Exception) {
            if (previous != null && fileOperationAllowed(operation)) consumedShare = previous
            finishFileOperation(operation, failure("Share discard could not start"))
        }
    }

    private fun discardResult(discarded: Boolean) = JSONObject().put("ok", true)
        .put("result", JSONObject().put("discarded", discarded))

    private fun interceptShare(source: WebView, authorization: RunAuthorization, request: WebResourceRequest): WebResourceResponse? {
        if (request.url.path?.startsWith("/native-share") != true) return null
        fun rejected() = WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden",
            mapOf("Cache-Control" to "no-store"), ByteArrayInputStream("Shared file is unavailable".toByteArray()))
        val consumed = consumedShare ?: return rejected()
        if (request.method != "GET" || request.isForMainFrame || consumed.authorization !== authorization || !canUseWorkbench(source, authorization)) return rejected()
        val token = request.requestHeaders.entries.firstOrNull { it.key.equals("x-jupiter-share", ignoreCase = true) }?.value
        val fileId = NativeShareStore.requestedFile(request.url.toString(), consumed.origin, consumed.share.id, token) ?: return rejected()
        val file = consumed.share.files.firstOrNull { it.id == fileId } ?: return rejected()
        var opened: java.io.InputStream? = null
        return try {
            val input = NativeShareStore.guarded(shares.open(consumed.share, fileId)) {
                consumedShare === consumed && canUseWorkbench(source, authorization)
            }
            opened = input
            WebResourceResponse(file.mime, null, 200, "OK", mapOf("Cache-Control" to "no-store", "X-Content-Type-Options" to "nosniff",
                "Content-Security-Policy" to "default-src 'none'; sandbox", "Content-Length" to file.size.toString()), input)
        } catch (_: Exception) { runCatching { opened?.close() }; rejected() }
    }

    private fun cameraChooser(operation: FileOperation, documents: Intent): Intent {
        val capture = Intent(MediaStore.ACTION_IMAGE_CAPTURE)
        if (capture.resolveActivity(packageManager) == null) return documents
        val directory = File(cacheDir, "captures")
        check(directory.isDirectory || directory.mkdirs())
        val file = File(directory, "${UUID.randomUUID()}.jpg")
        check(file.createNewFile())
        val uri = try { FileProvider.getUriForFile(this, "$packageName.files", file) }
        catch (failure: Exception) { file.delete(); throw failure }
        operation.capture = CameraCapture(file, uri)
        capture.putExtra(MediaStore.EXTRA_OUTPUT, uri)
        capture.clipData = ClipData.newRawUri("Jupiter capture", uri)
        capture.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        return Intent.createChooser(documents, "Add image").putExtra(Intent.EXTRA_INITIAL_INTENTS, arrayOf(capture))
    }

    private fun revokeCaptureGrant(uri: Uri) {
        runCatching { revokeUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION) }
    }

    private fun discardCapture(file: File) {
        runCatching { revokeCaptureGrant(FileProvider.getUriForFile(this, "$packageName.files", file)) }
        runCatching { file.delete() }
    }

    private fun revokeWorkbench() {
        speech.cancelCurrent()
        workbenchAuthorization?.revoke(); workbenchAuthorization = null
        deferredShareNotification = null
        consumedShare = null
        loadedRun = null; origin = ""
        inFlight.clear(); completed.clear()
        val operation = fileOperation
        operation?.authorization?.revoke()
        operation?.output?.close()
        runCatching { operation?.input?.close() }
        operation?.capture?.let { discardCapture(it.file) }; operation?.capture = null
        pageCaptures.forEach(::discardCapture); pageCaptures.clear()
        operation?.dialog?.dismiss(); operation?.dialog = null
        fileChooser?.onReceiveValue(null); fileChooser = null
        // Retain ownership until an outstanding picker returns or its IO finishes.
        if (operation != null && operation.pickerRequest == null && !operation.ioRunning) {
            finishFileOperation(operation, failure("Local runtime changed"))
        }
        web?.let { root.removeView(it); it.destroy() }; web = null
    }

    private fun failure(message: String) = JSONObject().put("ok", false).put("error", message)

    private fun beginFileOperation(reply: (JSONObject) -> Unit): FileOperation? {
        val service = engine
        val runId = loadedRun
        val state = service?.snapshot
        if (service == null || runId == null || state?.phase != "ready" || state.runId != runId || cancelled.get()) {
            reply(failure("Local runtime is not ready")); return null
        }
        if (pickerBusy()) { reply(failure("Another file operation is pending")); return null }
        return FileOperation(service, RunAuthorization(runId), service.paths?.workspaces, reply).also { fileOperation = it }
    }

    private fun fileOperationAllowed(operation: FileOperation): Boolean {
        val state = operation.service.snapshot
        return !cancelled.get() && fileOperation === operation && engine === operation.service &&
            operation.authorization.permits(loadedRun, state.phase, state.runId)
    }

    private fun requireFileOperation(operation: FileOperation) {
        check(fileOperationAllowed(operation)) { "File operation is no longer authorized" }
    }

    private fun finishFileOperation(operation: FileOperation, response: JSONObject, notifyShare: Boolean = false) {
        if (fileOperation !== operation) return
        operation.authorization.revoke()
        operation.capture?.let { discardCapture(it.file) }; operation.capture = null
        operation.dialog?.dismiss(); operation.dialog = null
        if (download?.operation === operation) download = null
        val callback = fileChooser; fileChooser = null
        fileOperation = null
        val deferred = deferredShareNotification
        deferredShareNotification = null
        try {
            callback?.onReceiveValue(null)
            operation.reply(response)
        } finally {
            if (notifyShare || (deferred != null && deferred === workbenchAuthorization)) notifyShareAvailable()
        }
    }

    private fun launchPicker(operation: FileOperation, intent: Intent, requestCode: Int) {
        if (!fileOperationAllowed(operation)) { finishFileOperation(operation, failure("Local runtime changed")); return }
        operation.pickerRequest = requestCode
        try { startActivityForResult(intent, requestCode) }
        catch (_: Exception) {
            operation.pickerRequest = null
            finishFileOperation(operation, failure("File dialog could not be opened"))
        }
    }

    private fun dispatchBridge(command: String, args: JSONObject, reply: (JSONObject) -> Unit) {
        when (command) {
            "consumeShare" -> consumeShare(reply)
            "acknowledgeShare" -> acknowledgeShare(args.optString("id"), reply)
            "discardShare" -> discardShare(if (args.has("id")) args.optString("id") else null, reply)
            "chooseWorkspace" -> chooseWorkspace(reply)
            "downloadFile" -> beginDownload(args.optString("fileId"), args.optString("name", "jupiter-export"), reply)
            "openExternal" -> { val opened = openExternal(Uri.parse(args.optString("url"))); reply(JSONObject().put("ok", opened).put("result", opened)) }
            "notificationStatus" -> reply(JSONObject().put("ok", true).put("result", notificationsAllowed()))
            "notificationPermission" -> {
                if (notificationReply != null) { reply(JSONObject().put("ok", false).put("error", "Notification permission is pending")); return }
                notificationReply = reply
                try {
                    if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                        requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), NOTIFY)
                    } else {
                        startActivityForResult(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName), NOTIFY_SETTINGS)
                    }
                } catch (_: Exception) { notificationReply = null; reply(failure("Notification settings could not be opened")) }
            }
            "notify" -> {
                if (notificationsAllowed()) {
                    val manager = getSystemService(NotificationManager::class.java)
                    manager.createNotificationChannel(NotificationChannel("jupiter-tasks", "Jupiter tasks", NotificationManager.IMPORTANCE_DEFAULT))
                    val open = android.app.PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), android.app.PendingIntent.FLAG_IMMUTABLE or android.app.PendingIntent.FLAG_UPDATE_CURRENT)
                    manager.notify(42, Notification.Builder(this, "jupiter-tasks").setSmallIcon(android.R.drawable.stat_notify_chat)
                        .setContentTitle(args.optString("title", "Jupiter").take(120)).setContentText(args.optString("body").take(300))
                        .setContentIntent(open).setAutoCancel(true).build())
                }
                reply(JSONObject().put("ok", true).put("result", notificationsAllowed()))
            }
            "stopRuntime" -> {
                val service = engine
                if (service == null) reply(failure("Local runtime is not ready"))
                else { reply(JSONObject().put("ok", true).put("result", true)); service.stopRuntime() }
            }
            else -> reply(JSONObject().put("ok", false).put("error", "Unsupported native operation"))
        }
    }

    private fun chooseWorkspace(reply: (JSONObject) -> Unit) {
        val operation = beginFileOperation(reply) ?: return
        try {
            operation.service.request("list_workspaces") { response ->
                if (!fileOperationAllowed(operation)) { finishFileOperation(operation, failure("Local runtime changed")); return@request }
                if (!response.optBoolean("ok")) { finishFileOperation(operation, response); return@request }
                try {
                    val items = response.getJSONArray("result")
                    val labels = Array(items.length()) { items.getJSONObject(it).optString("name") }
                    operation.dialog = AlertDialog.Builder(this).setTitle("Project").setItems(labels) { _, index ->
                        val result = if (fileOperationAllowed(operation)) JSONObject().put("ok", true).put("result", items.getJSONObject(index)) else failure("Local runtime changed")
                        finishFileOperation(operation, result)
                    }.setPositiveButton("Import ZIP") { _, _ ->
                        launchPicker(operation, Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/zip"), PICK_PROJECT)
                    }.setNegativeButton("Cancel") { _, _ -> finishFileOperation(operation, JSONObject().put("ok", true).put("result", JSONObject.NULL)) }
                        .setOnCancelListener { finishFileOperation(operation, JSONObject().put("ok", true).put("result", JSONObject.NULL)) }.create()
                    operation.dialog?.show()
                } catch (_: Exception) { finishFileOperation(operation, failure("Project dialog could not be opened")) }
            }
        } catch (_: Exception) { finishFileOperation(operation, failure("Project list could not be requested")) }
    }

    private fun pickerBusy() = fileOperation != null

    private fun beginDownload(id: String, name: String, reply: (JSONObject) -> Unit) {
        if (!UUID_PATTERN.matches(id) || pickerBusy()) { reply(JSONObject().put("ok", false).put("error", "File is unavailable or another dialog is open")); return }
        val safeName = name.substringAfterLast('/').substringAfterLast('\\').filterNot { it.isISOControl() }.take(160).ifBlank { "jupiter-export" }
        val operation = beginFileOperation(reply) ?: return
        try {
            download = Download(id, origin, CookieManager.getInstance().getCookie(origin) ?: "", operation)
            launchPicker(operation, Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                .setType("application/octet-stream").putExtra(Intent.EXTRA_TITLE, safeName), SAVE_FILE)
        } catch (_: Exception) { finishFileOperation(operation, failure("Export dialog could not be opened")) }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == NOTIFY_SETTINGS) {
            notificationReply?.invoke(JSONObject().put("ok", true).put("result", notificationsAllowed())); notificationReply = null
        } else if (requestCode == PICK_FILES) {
            val operation = fileOperation?.takeIf { it.pickerRequest == PICK_FILES } ?: return
            operation.pickerRequest = null
            val callback = fileChooser; fileChooser = null
            val capture = operation.capture
            val captured = resultCode == RESULT_OK && capture != null && capture.file.length() in 1..NativeShareStore.MAX_BYTES
            val uris = if (resultCode != RESULT_OK || (capture?.file?.length() ?: 0L) > NativeShareStore.MAX_BYTES) emptyList() else if (captured) listOf(capture!!.uri)
                else data?.clipData?.let { clip -> (0 until minOf(clip.itemCount, NativeShareStore.MAX_FILES + 1)).map { clip.getItemAt(it).uri } } ?: listOfNotNull(data?.data)
            val selected = uris.takeIf { fileOperationAllowed(operation) && it.size in 1..NativeShareStore.MAX_FILES && it.all { uri -> uri.scheme == "content" } }?.toTypedArray()
            if (captured && selected != null) {
                revokeCaptureGrant(capture!!.uri)
                pageCaptures.add(capture.file)
                operation.capture = null
            }
            finishFileOperation(operation, JSONObject().put("ok", true))
            callback?.onReceiveValue(selected)
        } else if (requestCode == PICK_PROJECT) {
            val operation = fileOperation?.takeIf { it.pickerRequest == PICK_PROJECT } ?: return
            operation.pickerRequest = null
            val uri = data?.data
            if (!fileOperationAllowed(operation)) { finishFileOperation(operation, failure("Local runtime changed or disconnected")); return }
            if (resultCode != RESULT_OK || uri?.scheme != "content") { finishFileOperation(operation, JSONObject().put("ok", true).put("result", JSONObject.NULL)); return }
            importProject(operation, uri)
        } else if (requestCode == SAVE_FILE) {
            val job = download ?: return
            val operation = job.operation
            if (fileOperation !== operation || operation.pickerRequest != SAVE_FILE) return
            operation.pickerRequest = null
            val uri = data?.data
            if (!fileOperationAllowed(operation)) { finishFileOperation(operation, failure("Local runtime changed or disconnected")); return }
            if (resultCode != RESULT_OK || uri?.scheme != "content") { finishFileOperation(operation, JSONObject().put("ok", true).put("result", JSONObject().put("cancelled", true))); return }
            saveDownload(job, uri)
        }
    }

    private fun importProject(operation: FileOperation, uri: Uri) {
        operation.ioRunning = true
        try {
            operation.service.runWork {
                try {
                    requireFileOperation(operation)
                    val workspaces = operation.workspaces ?: error("Runtime is not ready")
                    val input = contentResolver.openInputStream(uri) ?: error("Project cannot be opened")
                    operation.input = input
                    val result = ProjectArchive.importZip(input, workspaces) { !fileOperationAllowed(operation) }
                    requireFileOperation(operation)
                    val name = displayName(uri)
                    try {
                        ImportedProjectLabel.write(workspaces, result.directory.name, name) { fileOperationAllowed(operation) }
                    } catch (_: Exception) {
                        runOnUiThread { finishFileOperation(operation, failure("Project was imported, but its display name could not be saved. The imported project was kept.")) }
                        return@runWork
                    }
                    runOnUiThread {
                        operation.ioRunning = false
                        try {
                            requireFileOperation(operation)
                            operation.service.request("register_workspace", JSONObject().put("directory", result.directory.name).put("name", name)) { response ->
                                finishFileOperation(operation, if (fileOperationAllowed(operation)) response else failure("Local runtime changed"))
                            }
                        } catch (_: Exception) { finishFileOperation(operation, failure("Project registration did not complete")) }
                    }
                } catch (_: Exception) {
                    runOnUiThread { finishFileOperation(operation, failure("Project import failed or was cancelled. Existing projects were kept.")) }
                } finally { operation.input = null }
            }
        } catch (_: Exception) { finishFileOperation(operation, failure("Project import could not start")) }
    }

    private fun saveDownload(job: Download, uri: Uri) {
        val operation = job.operation
        operation.ioRunning = true
        try {
            operation.service.runWork {
                var connection: HttpURLConnection? = null
                val temporary = File(File(cacheDir, "exports"), UUID.randomUUID().toString())
                val response = try {
                    requireFileOperation(operation)
                    check(temporary.parentFile!!.isDirectory || temporary.parentFile!!.mkdirs()) { "Export cache is unavailable" }
                    connection = URL("${job.origin}/api/files/${job.id}").openConnection() as HttpURLConnection
                    connection.instanceFollowRedirects = false; connection.connectTimeout = 10000; connection.readTimeout = 30000
                    connection.setRequestProperty("Cookie", job.cookie)
                    if (connection.responseCode != 200) error("File download failed")
                    connection.inputStream.use { input ->
                        operation.input = input
                        temporary.outputStream().use { output -> copyBounded(input, output, operation) }
                    }
                    operation.input = null
                    requireFileOperation(operation)
                    val signal = CancellationSignal()
                    val output = CancellableOutput(onCancel = { signal.cancel() })
                    operation.output = output
                    output.copy({ temporary.inputStream() }, {
                        val descriptor = contentResolver.openFileDescriptor(uri, "wt", signal) ?: error("Export target cannot be written")
                        ParcelFileDescriptor.AutoCloseOutputStream(descriptor)
                    }, { fileOperationAllowed(operation) })
                    requireFileOperation(operation)
                    JSONObject().put("ok", true).put("result", JSONObject().put("saved", true))
                } catch (_: Exception) { failure("Export did not complete") }
                finally {
                    operation.input = null
                    operation.output = null
                    runCatching { connection?.disconnect() }
                    runCatching { temporary.delete() }
                }
                runOnUiThread { finishFileOperation(operation, if (fileOperationAllowed(operation)) response else failure("Export did not complete")) }
            }
        } catch (_: Exception) { finishFileOperation(operation, failure("Export could not start")) }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == NOTIFY) {
            notificationReply?.invoke(JSONObject().put("ok", true).put("result", notificationsAllowed())); notificationReply = null
        }
    }
    private fun notificationsAllowed(): Boolean = getSystemService(NotificationManager::class.java).areNotificationsEnabled()

    private fun copyBounded(input: java.io.InputStream, output: java.io.OutputStream, operation: FileOperation) {
        val buffer = ByteArray(65536); var total = 0L
        while (true) {
            requireFileOperation(operation)
            val count = input.read(buffer)
            requireFileOperation(operation)
            if (count < 0) break
            total += count; if (total > 512L * 1024 * 1024) error("Export exceeds its size limit")
            output.write(buffer, 0, count)
        }
    }

    private fun displayName(uri: Uri): String = runCatching {
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) cursor.getString(0).substringBeforeLast('.').filterNot { it.isISOControl() }.take(100) else null
        }
    }.getOrNull()?.takeIf { it.isNotBlank() } ?: "Imported project"

    private fun contentName(uri: Uri): String = runCatching {
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) cursor.getString(0) else null
        }
    }.getOrNull()?.let(NativeShareStore::fileName) ?: "shared-file"

    private fun openExternal(uri: Uri): Boolean {
        if (uri.scheme !in listOf("http", "https") || uri.host.isNullOrBlank()) return false
        return runCatching { startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)); true }.getOrDefault(false)
    }

    private fun handleBack() {
        val current = web
        if (current == null) { moveTaskToBack(true); return }
        current.evaluateJavascript("(()=>{const e=new CustomEvent('jupiter:android-back',{cancelable:true});return !window.dispatchEvent(e)})()") { handled ->
            if (handled != "true") moveTaskToBack(true)
        }
    }
    override fun onDestroy() {
        speechResumed = false
        speech.cancelCurrent()
        unregisterReceiver(speechLockReceiver)
        cancelled.set(true)
        clientStarted = false
        engine?.setClientActive(this, false)
        engine?.unobserve(observer)
        engine = null
        revokeWorkbench()
        notificationReply = null
        refreshShareIntakePending()
        if (bound) unbindService(connection)
        super.onDestroy()
    }

    private class FileOperation(val service: EngineService, val authorization: RunAuthorization,
                                val workspaces: File?, val reply: (JSONObject) -> Unit) {
        var pickerRequest: Int? = null
        var ioRunning = false
        var dialog: AlertDialog? = null
        var capture: CameraCapture? = null
        @Volatile var input: Closeable? = null
        @Volatile var output: CancellableOutput? = null
    }
    private data class Download(val id: String, val origin: String, val cookie: String, val operation: FileOperation)
    private data class CameraCapture(val file: File, val uri: Uri)
    private data class ConsumedShare(val share: NativeShareStore.Share, val authorization: RunAuthorization, val origin: String)
    companion object {
        private const val PICK_FILES = 701
        private const val PICK_PROJECT = 702
        private const val SAVE_FILE = 703
        private const val NOTIFY = 704
        private const val NOTIFY_SETTINGS = 705
        private const val SHARE_INTAKE_TOKEN = "jupiter.native.share-intake"
        private const val CAPTURE_FILES = "jupiter.native.captures"
        private val CAPTURE_NAME = Regex("[0-9a-f-]{36}\\.jpg")
        private val UUID_PATTERN = Regex("[0-9a-fA-F-]{36}")
    }
}
