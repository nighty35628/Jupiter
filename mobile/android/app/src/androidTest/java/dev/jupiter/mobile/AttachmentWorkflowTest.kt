package dev.jupiter.mobile

import android.content.ClipData
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.IBinder
import android.os.SystemClock
import android.util.Base64
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.core.content.FileProvider
import androidx.lifecycle.Lifecycle
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.internal.platform.app.ActivityInvoker
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleCallback
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Requires the QA workbench already configured for the local synthetic provider (WorkbenchTest).
 * Never replaces an existing draft, submits a prompt, changes settings, or enables WebView debugging.
 * Leaves the additive synthetic draft/token intact; only its acknowledged cache source is removed.
 */
@RunWith(AndroidJUnit4::class)
class AttachmentWorkflowTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val composer = "Array.from(document.querySelectorAll('.composer textarea')).find(e=>e.getClientRects().length)"

    @Test fun sharedTextAndFileSurviveRecreationAndIdleRestart() {
        val shares = NativeShareStore(File(context.cacheDir, "native-shares").canonicalFile)
        assertNull("Finish or discard earlier pending native shares before this isolated test", shares.first())
        val id = UUID.randomUUID().toString()
        val marker = "ATTACHMENT_WORKFLOW_TEXT_$id"
        val bytes = "Synthetic attachment $id\nUTF-8: \u4e2d\u6587\n".toByteArray(Charsets.UTF_8)
        val exports = File(context.cacheDir.canonicalFile, "exports")
        assertTrue("Could not prepare the private export fixture", exports.isDirectory || exports.mkdirs())
        assertEquals("Export fixture parent must not be a symbolic link", exports, exports.canonicalFile)
        val source = File(exports, "attachment-workflow-$id.txt")
        assertTrue("Fixture unexpectedly already exists", source.createNewFile())
        source.writeBytes(bytes)
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", source)
        assertEquals("content", uri.scheme)
        val incoming = Intent(context, MainActivity::class.java).apply {
            action = Intent.ACTION_SEND
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, marker)
            putExtra(Intent.EXTRA_STREAM, uri)
            clipData = ClipData.newUri(context.contentResolver, "Synthetic attachment", uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        try {
            ShareActivity().use { scenario ->
                scenario.launch(incoming)
                withService { service ->
                    val page = Page(scenario)
                    val first = awaitPhase(service, "ready", 240)
                    val firstRun = requireNotNull(first.runId)
                    page.await("($composer)?.value.includes(${JSONObject.quote(marker)})===true", 120)
                    page.await("!document.querySelector('.splash')")
                    page.await("document.querySelector('meta[name=\"jupiter-run\"]')?.content===${JSONObject.quote(firstRun)}")
                    awaitAcknowledged(shares)

                    val initialDraft = page.string("($composer).value")
                    val token = FILE_TOKEN.find(initialDraft.substringAfter(marker))?.value
                        ?: throw AssertionError("Shared text arrived without its jupiter-file attachment")
                    val fileId = token.substringAfter("@jupiter-file:")
                    val originalPrefix = initialDraft.substringBefore(marker)
                    assertDraft(page, marker, token, originalPrefix)
                    assertNotAutomaticallySent(page, marker)
                    assertFileBytes(page, fileId, bytes)

                    scenario.recreate()
                    awaitPhase(service, "ready", 90)
                    assertDraft(page, marker, token, originalPrefix, 90)
                    assertNotAutomaticallySent(page, marker)
                    assertFileBytes(page, fileId, bytes)
                    awaitAcknowledged(shares)
                    assertEquals("Activity recreation restarted the runtime", firstRun, service.snapshot.runId)

                    awaitKnownIdle(service, 30)
                    val backgroundAt = SystemClock.elapsedRealtime()
                    scenario.moveToState(Lifecycle.State.CREATED)
                    awaitPhase(service, "idle", 100)
                    assertTrue("Runtime stopped before the 60-second background grace", SystemClock.elapsedRealtime() - backgroundAt >= 60_000)
                    assertEquals("The activity left its requested background state", Stage.STOPPED, scenario.stage)

                    scenario.moveToState(Lifecycle.State.RESUMED)
                    val reopened = awaitPhase(service, "ready", 120)
                    val nextRun = requireNotNull(reopened.runId)
                    assertNotEquals("Idle restart reused the previous runtime generation", firstRun, nextRun)
                    assertEquals("Idle restart changed the draft storage origin", java.net.URI(first.url).authority, java.net.URI(reopened.url).authority)
                    page.await("document.querySelector('meta[name=\"jupiter-run\"]')?.content===${JSONObject.quote(nextRun)}", 90)
                    assertDraft(page, marker, token, originalPrefix, 90)
                    assertNotAutomaticallySent(page, marker)
                    assertFileBytes(page, fileId, bytes)
                    awaitAcknowledged(shares)
                    assertNull("Native acknowledgement did not dequeue the share", shares.first())
                }
            }
        } finally {
            // A failed, still-pending intake must retain its content URI source for diagnosis/retry.
            if (runCatching { shares.first() == null }.getOrDefault(false)) {
                assertTrue("Could not remove the generated cache fixture", source.delete() || !source.exists())
            }
        }
    }

    private fun assertDraft(page: Page, marker: String, token: String, prefix: String, seconds: Long = 20) {
        page.await("($composer)?.value.includes(${JSONObject.quote(marker)})===true&&($composer).value.includes(${JSONObject.quote(token)})", seconds)
        val draft = page.string("($composer).value")
        assertTrue("Existing draft content was replaced", draft.startsWith(prefix))
        assertEquals("Share text was inserted more than once", 1, Regex(Regex.escape(marker)).findAll(draft).count())
        assertEquals("Shared attachment was inserted more than once", 1, Regex(Regex.escape(token)).findAll(draft).count())
    }

    private fun assertNotAutomaticallySent(page: Page, marker: String) {
        assertEquals("Share text appeared as a submitted/queued user message", "true", page.eval(
            "return Array.from(document.querySelectorAll('.msg.user')).every(e=>!e.textContent.includes(${JSONObject.quote(marker)}))"
        ))
    }

    private fun assertFileBytes(page: Page, fileId: String, expected: ByteArray) {
        val path = JSONObject.quote("/api/files/$fileId")
        assertEquals("true", page.eval("""
            window.__qaRead={done:false};
            fetch($path,{method:'GET',credentials:'same-origin',mode:'same-origin',cache:'no-store',redirect:'error'})
              .then(async response=>{
                const bytes=new Uint8Array(await response.arrayBuffer());
                window.__qaRead={done:true,status:response.status,base64:btoa(Array.from(bytes,b=>String.fromCharCode(b)).join(''))};
              })
              .catch(error=>{window.__qaRead={done:true,error:String(error)}});
            return true;
        """.trimIndent()))
        page.await("window.__qaRead?.done===true", 30)
        val result = JSONObject(page.string("JSON.stringify(window.__qaRead)"))
        assertFalse("Authenticated attachment GET failed: ${result.optString("error")}", result.has("error"))
        assertEquals("Attachment token no longer authorizes GET", 200, result.getInt("status"))
        assertEquals("Attachment bytes changed", Base64.encodeToString(expected, Base64.NO_WRAP), result.getString("base64"))
    }

    private fun awaitAcknowledged(shares: NativeShareStore) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
        while (System.nanoTime() < deadline) {
            if (shares.first() == null) return
            Thread.sleep(100)
        }
        throw AssertionError("Production React did not acknowledge the native share")
    }

    private fun awaitKnownIdle(service: EngineService, seconds: Long) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds)
        while (System.nanoTime() < deadline) {
            val state = service.snapshot
            assertNotEquals("Runtime failed: ${state.message}", "fault", state.phase)
            if (state.phase == "ready" && state.active == 0 && state.idleReady) return
            Thread.sleep(100)
        }
        throw AssertionError("Runtime did not report known idle readiness before backgrounding")
    }

    private fun awaitPhase(service: EngineService, phase: String, seconds: Long): EngineService.Snapshot {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds)
        while (System.nanoTime() < deadline) {
            val state = service.snapshot
            if (state.phase == phase) return state
            assertNotEquals("Runtime failed: ${state.message}", "fault", state.phase)
            Thread.sleep(100)
        }
        throw AssertionError("Runtime did not reach $phase (last phase ${service.snapshot.phase})")
    }

    private fun withService(block: (EngineService) -> Unit) {
        val connected = CountDownLatch(1)
        var service: EngineService? = null
        val connection = object : ServiceConnection {
            override fun onServiceConnected(name: ComponentName, binder: IBinder) {
                service = (binder as EngineService.LocalBinder).service()
                connected.countDown()
            }
            override fun onServiceDisconnected(name: ComponentName) { service = null }
        }
        instrumentation.runOnMainSync {
            assertTrue(context.bindService(Intent(context, EngineService::class.java), connection, Context.BIND_AUTO_CREATE))
        }
        try {
            assertTrue("Service binding timed out", connected.await(10, TimeUnit.SECONDS))
            block(requireNotNull(service))
        } finally {
            instrumentation.runOnMainSync { service?.stopRuntime(); context.unbindService(connection) }
        }
    }

    /**
     * core:1.6.1 ActivityScenario filters every callback against the original Intent, including
     * action/type and API 29+ identifier. A consumed share deliberately changes all three.
     * Retain its real AndroidX lifecycle driver, but track our component/task/instance instead.
     */
    private class ShareActivity : AutoCloseable {
        private val instrumentation = InstrumentationRegistry.getInstrumentation()
        private val monitor = ActivityLifecycleMonitorRegistry.getInstance()
        // This is ActivityScenario's pinned default driver, not a production activity invoker.
        private val invoker = Class.forName("androidx.test.core.app.InstrumentationActivityInvoker")
            .getDeclaredConstructor().apply { isAccessible = true }.newInstance() as ActivityInvoker
        private var current: MainActivity? = null
        private var taskId: Int? = null
        private var lastStage = Stage.PRE_ON_CREATE
        private var recreating: MainActivity? = null
        private val observer = ActivityLifecycleCallback { activity, next ->
            if (activity is MainActivity) {
                if (activity === current) lastStage = next
                else if (next == Stage.CREATED && (current == null ||
                        (recreating === current && activity.taskId == taskId))) {
                    current = activity
                    taskId = activity.taskId
                    lastStage = next
                }
            }
        }

        init { instrumentation.runOnMainSync { monitor.addLifecycleCallback(observer) } }

        val stage: Stage get() {
            var result = Stage.PRE_ON_CREATE
            instrumentation.runOnMainSync { result = lastStage }
            return result
        }

        fun launch(intent: Intent) {
            assertEquals(ComponentName(instrumentation.targetContext, MainActivity::class.java), intent.component)
            invoker.startActivity(Intent(intent))
            awaitStage(Stage.RESUMED)
        }

        fun onActivity(block: (MainActivity) -> Unit) {
            instrumentation.runOnMainSync {
                check(lastStage == Stage.RESUMED) { "Workbench is not resumed: $lastStage" }
                block(requireNotNull(current))
            }
        }

        fun recreate() {
            val previous = activity()
            instrumentation.runOnMainSync { recreating = previous }
            try {
                invoker.recreateActivity(previous)
                awaitStage(Stage.RESUMED, previous)
            } finally { instrumentation.runOnMainSync { recreating = null } }
        }

        fun moveToState(state: Lifecycle.State) {
            when (state) {
                Lifecycle.State.CREATED -> {
                    invoker.stopActivity(activity())
                    awaitStage(Stage.STOPPED)
                }
                Lifecycle.State.RESUMED -> {
                    invoker.resumeActivity(activity())
                    awaitStage(Stage.RESUMED)
                }
                else -> throw IllegalArgumentException("Unsupported test lifecycle state: $state")
            }
        }

        private fun activity(): MainActivity {
            var result: MainActivity? = null
            instrumentation.runOnMainSync { result = current }
            return requireNotNull(result) { "Share activity was not created" }
        }

        private fun awaitStage(expected: Stage, previous: MainActivity? = null) {
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(45)
            while (System.nanoTime() < deadline) {
                var reached = false
                instrumentation.runOnMainSync {
                    reached = lastStage == expected &&
                        (previous == null || (current !== previous && previous.isDestroyed))
                }
                if (reached) return
                Thread.sleep(100)
            }
            throw AssertionError("Share activity did not reach $expected (last stage $stage)")
        }

        override fun close() {
            try {
                var live: MainActivity? = null
                instrumentation.runOnMainSync { if (lastStage != Stage.DESTROYED) live = current }
                live?.let { invoker.finishActivity(it); awaitStage(Stage.DESTROYED) }
            } finally { instrumentation.runOnMainSync { monitor.removeLifecycleCallback(observer) } }
        }
    }

    private class Page(private val scenario: ShareActivity) {
        fun eval(script: String): String {
            val done = CountDownLatch(1)
            var result: String? = null
            scenario.onActivity { activity ->
                val view = findWeb(activity.findViewById(android.R.id.content))
                if (view == null) done.countDown()
                else view.evaluateJavascript("(()=>{$script})()") { value -> result = value; done.countDown() }
            }
            assertTrue("WebView evaluation timed out", done.await(10, TimeUnit.SECONDS))
            return result ?: "null"
        }

        fun string(expression: String): String {
            val encoded = eval("return $expression")
            assertNotEquals("Workbench string was unavailable", "null", encoded)
            return JSONArray("[$encoded]").getString(0)
        }

        fun await(expression: String, seconds: Long = 20) {
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds)
            while (System.nanoTime() < deadline) {
                if (eval("return !!($expression)") == "true") return
                Thread.sleep(100)
            }
            throw AssertionError("Workbench condition timed out: $expression")
        }

        private fun findWeb(view: View): WebView? {
            if (view is WebView) return view
            if (view is ViewGroup) for (index in 0 until view.childCount) findWeb(view.getChildAt(index))?.let { return it }
            return null
        }
    }

    companion object {
        private val FILE_TOKEN = Regex("@jupiter-file:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", RegexOption.IGNORE_CASE)
    }
}
