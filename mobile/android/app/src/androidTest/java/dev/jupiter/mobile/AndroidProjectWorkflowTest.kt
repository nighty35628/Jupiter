package dev.jupiter.mobile

import android.content.Intent
import android.accessibilityservice.AccessibilityServiceInfo
import android.graphics.Rect
import android.os.Bundle
import android.os.SystemClock
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.net.URI
import java.util.UUID
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Sidecar for the already configured QA app and existing synthetic Download fixture (22016 bytes).
 * No provider configuration writes, RPC submissions, fixture repair, screenshots or UI dumps.
 * The provider's command requires check.py + seed.txt; a marker alone is not strict success.
 */
@RunWith(AndroidJUnit4::class)
class AndroidProjectWorkflowTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val arguments get() = InstrumentationRegistry.getArguments()
    private val activeMain = ".main:not([style*=none])"
    private val composer = "$activeMain .composer textarea"
    private fun visibleNodes(selector: String) =
        "Array.from(document.querySelectorAll(${JSONObject.quote(selector)})).filter(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden')"
    private fun activeNodes(selector: String) = visibleNodes("$activeMain $selector")
    private fun activeNode(selector: String) = "${activeNodes(selector)}[0]"
    private val visibleComposer = activeNode(".composer textarea")
    // After the first turn only the session-bound tab retains the workspace label.
    private val projectSelected = """
        ${activeNodes(".composer-workspace-btn")}.every(e=>/^mobile-project-git(?: \(workspaces\)(?: [2-9][0-9]*)?)?$/.test(e.textContent.trim())) &&
        /^mobile-project-git(?: \(workspaces\)(?: [2-9][0-9]*)?)?$/.test(document.querySelector('.tabbar [aria-selected=true]')?.getAttribute('aria-label')||'')
    """.trimIndent()
    private val idle = """
        ${visibleNodes(activeMain)}.length===1 &&
        document.querySelector('.tabbar [aria-selected=true] .dot')?.dataset.state==='idle' &&
        ${activeNodes(".send-btn[title=stop]")}.length===0 &&
        ${activeNodes(".composer-busy-status")}.length===0 &&
        ${activeNodes(".msg.assistant[data-pending=true]")}.length===0 &&
        ${activeNodes(".approval")}.length===0 &&
        !!($visibleComposer) && !($visibleComposer).disabled
    """.trimIndent()

    @Test fun importZipThenVerifyToolsAndApprovedCommand() {
        requireLocalProvider()
        assertEquals("Only the isolated QA application is allowed", QA, instrumentation.targetContext.packageName)
        instrumentation.uiAutomation.serviceInfo = instrumentation.uiAutomation.serviceInfo.apply {
            flags = flags or AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
        }
        status("launch")
        ActivityScenario.launch<MainActivity>(Intent(instrumentation.targetContext, MainActivity::class.java)).use { scenario ->
            val page = WorkbenchTest.Page(scenario)
            page.await("document.querySelector('.tabbar .newtab')!==null&&!document.querySelector('.splash')", 240)
            stable(page, "document.documentElement.lang==='en'")
            if (arguments.getString("existingProject") != "true") {
            val oldCount = page.eval("return document.querySelectorAll('.tabbar [role=tab]').length").toInt()
            tap(page, ".tabbar .newtab")
            page.await("document.querySelectorAll('.tabbar [role=tab]').length===${oldCount + 1}", 90)
            stable(page, "($visibleComposer)?.value===''&&($idle)", 90)
            // Never depend on the restored session, nor replace any pre-existing tab's draft.
            stable(page, "${visibleNodes(activeMain)}.length===1&&${activeNodes(".thread")}.length===1&&${activeNodes(".thread-inner--standalone")}.length===1&&${activeNodes(".thread .msg")}.length===0&&($visibleComposer)?.value===''")
            status("new_tab_ready")
            verifyProvider(page)

            tap(page, "$activeMain .composer-workspace-btn")
            tapText(page, ".wd-foot button", "Browse local\u2026")
            nativeTap("Import ZIP", setOf(QA)) {
                it.viewIdResourceName == "android:id/button1" && it.text?.toString()?.equals("Import ZIP", ignoreCase = true) == true
            }
            status("saf_select_synthetic_fixture")
            if (arguments.getString("manualFixture") == "true") {
                status("await_manual_synthetic_fixture")
                page.await("!document.querySelector('.wd-pop')&&($projectSelected)", 600)
            } else selectFixture()
            page.await("!document.querySelector('.wd-pop')", 90)
            }
            stable(page, """
                ($projectSelected) &&
                ($visibleComposer)?.value==='' && ($idle)
            """.trimIndent(), 90)
            val projectSession = page.eval("return document.querySelector('.tabbar [aria-selected=true]')?.dataset.sessionId")
            assertTrue("Imported project has no session identity", projectSession.startsWith("\"") && projectSession.length > 2)
            status("imported_project_active")

            // Routine file tools may run; shell execution must still ask for one-time approval.
            if (page.eval("return ${activeNode(".composer-permission")}?.dataset.mode==='auto'") != "true") {
                tap(page, "$activeMain .composer-permission")
                tap(page, "$activeMain .composer-mode-option[data-mode=auto]")
            }
            stable(page, "${activeNode(".composer-permission")}?.dataset.mode==='auto'")
            askOff(page)
            val suffix = UUID.randomUUID().toString()
            val toolsMarker = "SMOKE:android-tools-$suffix"
            send(page, toolsMarker, projectSession)
            awaitVerified(page, toolsMarker, command = false)
            status("tools_verified_idle", toolsMarker)

            val commandMarker = "SMOKE:android-command-$suffix"
            send(page, commandMarker, projectSession)
            val approvals = awaitVerified(page, commandMarker, command = true)
            assertTrue("Shell execution bypassed Run once approval", approvals > 0)
            status("strict_command_verified_idle", commandMarker)
            if (arguments.getString("verifyGitReview") == "true") verifyGitReview(page)
            status("passed", commandMarker)
        }
    }

    private fun requireLocalProvider(): String {
        val endpoint = arguments.getString("providerUrl")
            ?: throw AssertionError("Explicit providerUrl is required; no default provider allowed")
        val uri = try { URI(endpoint) } catch (_: Exception) { throw AssertionError("Invalid local providerUrl") }
        assertTrue("Refusing any provider other than the expected loopback smoke endpoint",
            uri.scheme == "http" && uri.host in setOf("127.0.0.1", "localhost") &&
                uri.port == 51488 && uri.rawPath == "/v1" && uri.rawUserInfo == null &&
                uri.rawQuery == null && uri.rawFragment == null)
        return endpoint
    }

    private fun verifyProvider(page: WorkbenchTest.Page) {
        val endpoint = requireLocalProvider()
        if (page.eval("return document.querySelector('.app')?.dataset.sideCollapsed==='true'") == "true")
            tap(page, ".titlebar button[title='Sidebar']")
        tap(page, ".side-foot .row")
        tapText(page, ".settings-card button", "Settings")
        tapText(page, ".settings-side button", "Models")
        // Read only booleans. Never log URLs, keys, settings contents, or old conversations.
        stable(page, """
            document.querySelector('[aria-label="Provider base URL"]')?.value===${JSONObject.quote(endpoint)} &&
            document.querySelector('[aria-label="Custom model id"]')?.value==='smoke-model'
        """.trimIndent())
        tap(page, ".settings-head .close-btn")
        page.await("!document.querySelector('.settings-head')")
        if (page.eval("return document.querySelector('.app')?.dataset.sideCollapsed==='false'") == "true")
            tap(page, ".titlebar button[title='Sidebar']")
        stable(page, "${activeNode(".composer .model-pill > span")}?.textContent.trim()==='smoke-model'")
    }

    private fun askOff(page: WorkbenchTest.Page) {
        page.await("${activeNodes(".composer-ask-toggle")}.length===1")
        if (page.eval("return ${activeNode(".composer-ask-toggle")}?.getAttribute('aria-pressed')==='true'") == "true")
            tap(page, "$activeMain .composer-ask-toggle")
        stable(page, "${activeNode(".composer-ask-toggle")}?.getAttribute('aria-pressed')==='false'")
    }

    private fun send(page: WorkbenchTest.Page, marker: String, projectSession: String) {
        stable(page, idle, 30)
        verifyProvider(page)
        askOff(page)
        stable(page, "($visibleComposer)?.value===''")
        page.input(composer, marker)
        stable(page, """
            ($visibleComposer)?.value===${JSONObject.quote(marker)} && ($idle) &&
            document.querySelector('.tabbar [aria-selected=true]')?.dataset.sessionId===$projectSession &&
            ($projectSelected) &&
            ${activeNode(".composer-permission")}?.dataset.mode==='auto' &&
            ${activeNode(".composer-ask-toggle")}?.getAttribute('aria-pressed')==='false' &&
            ${activeNodes(".send-btn")}.some(e=>!e.disabled)
        """.trimIndent())
        requireLocalProvider()
        status("sending", marker)
        tap(page, "$activeMain .composer .send-btn:not([title=stop])")
        page.await("${activeNodes(".thread .msg.user .msg-text")}.some(e=>e.textContent.trim()===${JSONObject.quote(marker)})", 30)
    }

    private fun awaitVerified(page: WorkbenchTest.Page, marker: String, command: Boolean): Int {
        val expected = JSONObject.quote("LOCAL_OK $marker TOOLS_VERIFIED")
        val failed = JSONObject.quote("LOCAL_OK $marker TOOL_RESULTS_FAILED")
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(180)
        var approvals = 0
        while (System.nanoTime() < deadline) {
            assertFalse("Synthetic provider rejected the tool results for this turn", page.eval(
                "return ${activeNodes(".thread .msg.assistant")}.some(e=>e.textContent.includes($failed))"
            ) == "true")
            if (page.eval("return ${activeNodes(".thread .msg.assistant .msg-text")}.some(e=>e.textContent.trim()===$expected)&&($idle)") == "true") {
                stable(page, "${activeNodes(".thread .msg.assistant .msg-text")}.some(e=>e.textContent.trim()===$expected)&&($idle)")
                return approvals
            }
            if (page.eval("return ${activeNodes(".approval")}.some(e=>!e.closest('fieldset[disabled]'))") == "true") {
                assertTrue("Unexpected approval during routine file tools", command)
                assertTrue("Too many shell approvals", approvals < 3)
                requireLocalProvider()
                // Whitelist the exact synthetic command, not any Run once button on the page.
                assertEquals("Expected synthetic command was not the approval preview", "true", page.eval("""
                    const normalize=s=>s.trim().replace(/\s+/g,' ');
                    const cards=${activeNodes(".approval")}.filter(e=>!e.closest('fieldset[disabled]'));
                    if(cards.length!==1)return false;
                    const card=cards[0],preview=card.querySelector('.ap-preview');
                    if(!preview||normalize(preview.textContent)!==normalize(${JSONObject.quote("$ $VALIDATION_COMMAND")}))return false;
                    const button=Array.from(card.querySelectorAll('.ap-foot button')).find(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden'&&e.textContent.trim()==='Run once');
                    if(!button||button.disabled||button.closest('fieldset[disabled]'))return false;
                    button.setAttribute('data-project-workflow-run','true');
                    button.scrollIntoView({block:'center'});return true;
                """.trimIndent()))
                tap(page, "$activeMain [data-project-workflow-run=true]")
                approvals++
                status("run_once_approved", marker)
                page.await("${activeNodes("[data-project-workflow-run=true]")}.every(e=>e.disabled||e.closest('fieldset[disabled]')!==null)", 20)
            }
            Thread.sleep(150)
        }
        throw AssertionError("Timed out waiting for this turn's exact TOOLS_VERIFIED response and idle: $marker")
    }

    private fun selectFixture() {
        awaitNative("SAF", SAF) { true }.recycle()
        nativeTap("SAF roots", SAF) {
            it.viewIdResourceName == "android:id/home" || it.contentDescription?.toString() in setOf(
                "Show roots", "Open navigation drawer", "\u663e\u793a\u6839\u76ee\u5f55", "\u6253\u5f00\u5bfc\u822a\u62bd\u5c49")
        }
        nativeTap("Downloads root", SAF) { it.text?.toString() in DOWNLOADS }
        awaitNative("Downloads location", SAF) {
            it.text?.toString() in DOWNLOADS && it.viewIdResourceName?.endsWith(":id/breadcrumb_text") == true
        }.recycle()
        // Search only inside Downloads, never choose a similarly named recent file.
        nativeTap("SAF search", SAF) {
            it.viewIdResourceName?.endsWith(":id/option_menu_search") == true ||
                it.contentDescription?.toString() in setOf("Search", "\u641c\u7d22")
        }
        val search = awaitNative("SAF search input", SAF) { it.isEditable && it.className?.toString() == "android.widget.EditText" }
        try {
            assertTrue("Could not set synthetic fixture search", search.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT,
                Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, FIXTURE) }))
        } finally { search.recycle() }
        val value = awaitNative("Exact SAF search value", SAF) { it.isEditable && it.text?.toString() == FIXTURE }
        value.recycle()
        instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_ENTER)
        // Only a unique file-title row can be selected, never the search field or a near match.
        nativeTap("Unique exact synthetic ZIP title", SAF, unique = true) {
            !it.isEditable && it.text?.toString() == FIXTURE && it.viewIdResourceName?.endsWith(":id/title") == true
        }
        status("exact_fixture_tapped")
        // Some SAF versions select first and require the explicit Open button.
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(90)
        while (System.nanoTime() < deadline) {
            val root = instrumentation.uiAutomation.rootInActiveWindow
            val pkg = root?.packageName?.toString()
            root?.recycle()
            if (pkg == QA) return
            if (pkg in SAF && nativeBounds(SAF) {
                    it.text?.toString() in setOf("OPEN", "Open", "\u6253\u5f00") && it.isClickable
                } != null) {
                nativeTap("SAF Open", SAF) { it.text?.toString() in setOf("OPEN", "Open", "\u6253\u5f00") && it.isClickable }
            }
            Thread.sleep(150)
        }
        throw AssertionError("SAF did not return to the QA application after exact fixture selection")
    }

    private fun verifyGitReview(page: WorkbenchTest.Page) {
        if (page.eval("return document.querySelector('.app')?.dataset.ctxCollapsed==='false'") != "true")
            tap(page, "button[title='Toggle right sidebar']")
        page.await("document.querySelector('.app')?.dataset.ctxCollapsed==='false'")
        // ContextPanel is an active-only sibling of main (App.tsx), not a main descendant.
        stable(page, "${visibleNodes(".ctx:not([inert])")}.length===1")
        tap(page, ".ctx:not([inert]) .ctx-tab-add")
        tapText(page, ".ctx-tab-menu button", "Review")
        stable(page, """
            ${visibleNodes(".ctx:not([inert])[data-mode=review] .ctx-review")}.length===1 &&
            ${visibleNodes(".ctx:not([inert]) .ctx-review .ctx-browser-error")}.length===0 &&
            ['long-a.txt','long-b.txt'].every(path=>${visibleNodes(".ctx:not([inert]) .ctx-review-file-path")}.some(e=>e.textContent.trim()===path))
        """.trimIndent(), 30)
        status("git_review_verified")
    }

    private fun tap(page: WorkbenchTest.Page, selector: String) {
        page.awaitDraw()
        page.tap(selector)
    }

    private fun tapText(page: WorkbenchTest.Page, selector: String, text: String) {
        val query = "${visibleNodes(selector)}.filter(e=>e.textContent.trim()===${JSONObject.quote(text)})"
        stable(page, "$query.length===1")
        assertEquals("true", page.eval("document.querySelectorAll('[data-project-workflow-text]').forEach(e=>e.removeAttribute('data-project-workflow-text'));const e=$query[0];if(!e)return false;e.setAttribute('data-project-workflow-text','true');e.scrollIntoView({block:'nearest'});return true"))
        tap(page, "[data-project-workflow-text=true]")
    }

    private fun stable(page: WorkbenchTest.Page, expression: String, seconds: Long = 20) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds)
        var consecutive = 0
        while (System.nanoTime() < deadline) {
            consecutive = if (page.eval("return !!($expression)") == "true") consecutive + 1 else 0
            if (consecutive >= 3) { page.awaitDraw(); return }
            Thread.sleep(150)
        }
        throw AssertionError("QA workbench did not reach the required stable condition: $expression")
    }

    private fun awaitNative(label: String, packages: Set<String>, matches: (AccessibilityNodeInfo) -> Boolean): AccessibilityNodeInfo {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
        while (System.nanoTime() < deadline) {
            for (root in nativeRoots(packages)) {
                try { findNative(root, matches)?.let { return it } }
                finally { root.recycle() }
            }
            Thread.sleep(150)
        }
        throw AssertionError("Required native control unavailable: $label (no system UI captured)")
    }

    private fun nativeRoots(packages: Set<String>): List<AccessibilityNodeInfo> {
        val roots = mutableListOf<AccessibilityNodeInfo>()
        val active = instrumentation.uiAutomation.rootInActiveWindow
        if (active != null) {
            if (active.packageName?.toString() in packages) roots.add(active) else active.recycle()
        }
        if (roots.isEmpty()) for (window in instrumentation.uiAutomation.windows) {
            val root = window.root ?: continue
            if (root.packageName?.toString() in packages) roots.add(root) else root.recycle()
        }
        return roots
    }

    private fun findNative(node: AccessibilityNodeInfo, matches: (AccessibilityNodeInfo) -> Boolean): AccessibilityNodeInfo? {
        if (node.isVisibleToUser && node.isEnabled && matches(node)) return AccessibilityNodeInfo.obtain(node)
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            try { findNative(child, matches)?.let { return it } } finally { child.recycle() }
        }
        return null
    }

    private fun nativeBounds(packages: Set<String>, unique: Boolean = false, matches: (AccessibilityNodeInfo) -> Boolean): Rect? {
        for (root in nativeRoots(packages)) try {
            if (unique) {
                val bounds = mutableListOf<Rect>()
                collectNativeBounds(root, matches, bounds)
                bounds.distinct().singleOrNull()?.let { return it }
                continue
            }
            val node = findNative(root, matches) ?: continue
            try { return Rect().also { node.getBoundsInScreen(it) }.takeUnless { it.isEmpty } }
            finally { node.recycle() }
        } finally { root.recycle() }
        return null
    }

    private fun collectNativeBounds(node: AccessibilityNodeInfo, matches: (AccessibilityNodeInfo) -> Boolean, bounds: MutableList<Rect>) {
        if (node.isVisibleToUser && node.isEnabled && matches(node)) {
            val rect = Rect().also { node.getBoundsInScreen(it) }
            if (!rect.isEmpty) bounds.add(rect)
        }
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            try { collectNativeBounds(child, matches, bounds) } finally { child.recycle() }
        }
    }

    private fun nativeTap(label: String, packages: Set<String>, unique: Boolean = false, matches: (AccessibilityNodeInfo) -> Boolean) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
        var previous: Rect? = null
        while (System.nanoTime() < deadline) {
            val bounds = nativeBounds(packages, unique, matches)
            if (bounds != null && bounds == previous) {
                val down = SystemClock.uptimeMillis()
                for (action in listOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP)) {
                    val event = MotionEvent.obtain(down, SystemClock.uptimeMillis(), action, bounds.exactCenterX(), bounds.exactCenterY(), 0)
                    event.source = InputDevice.SOURCE_TOUCHSCREEN
                    try { assertTrue("Native touch failed: $label", instrumentation.uiAutomation.injectInputEvent(event, true)) }
                    finally { event.recycle() }
                    if (action == MotionEvent.ACTION_DOWN) Thread.sleep(70)
                }
                return
            }
            previous = bounds
            Thread.sleep(150)
        }
        throw AssertionError("Native touch target unavailable or unstable: $label (no system UI captured)")
    }

    private fun status(stage: String, marker: String? = null) {
        val value = JSONObject().put("stage", stage).apply { if (marker != null) put("marker", marker) }.toString()
        println("JUPITER_PROJECT_WORKFLOW=$value")
        instrumentation.sendStatus(0, Bundle().apply { putString("jupiterProjectWorkflow", value) })
    }

    companion object {
        private const val QA = "dev.jupiter.mobile.qa"
        private const val FIXTURE = "mobile-project-git.zip"
        private val SAF = setOf("com.android.documentsui", "com.google.android.documentsui")
        private val DOWNLOADS = setOf("Downloads", "Download", "\u4e0b\u8f7d", "\u4e0b\u8f7d\u5185\u5bb9")
        private val VALIDATION_COMMAND = "/bin/bash -lc 'set -eu\npython3 check.py\nnode -e \"if(40+2!==42)process.exit(1);console.log(42)\"\ngit status --short\ngit diff --stat'"
    }
}
