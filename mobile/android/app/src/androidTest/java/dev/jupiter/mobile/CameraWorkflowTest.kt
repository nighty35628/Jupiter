package dev.jupiter.mobile

import android.content.Intent
import android.graphics.Bitmap
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Uses the emulator's real camera activity, not a substituted WebView file list. */
@RunWith(AndroidJUnit4::class)
class CameraWorkflowTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()

    @Test fun cameraCancelThenCaptureUsesNormalAttachmentAndProviderPipeline() {
        val endpoint = InstrumentationRegistry.getArguments().getString("providerUrl")
            ?: throw AssertionError("Pass an explicit local synthetic providerUrl")
        val uri = java.net.URI(endpoint)
        require(uri.scheme == "http" && uri.host == "127.0.0.1" && uri.port > 0 && uri.path == "/v1")
        ActivityScenario.launch<MainActivity>(Intent(instrumentation.targetContext, MainActivity::class.java)).use { scenario ->
            val page = WorkbenchTest.Page(scenario)
            page.await("document.querySelector('textarea')!==null", 240)
            page.await("!document.querySelector('.splash')")
            page.click(".titlebar button[title='Sidebar']")
            page.click(".side-foot .row")
            page.clickText(".settings-card button", "Settings")
            page.clickText(".settings-side button", "Models")
            page.await("document.querySelector('#provider-vision')!==null")
            assertEquals("true", page.eval("return document.querySelector('[aria-label=\"Provider base URL\"]').value===${org.json.JSONObject.quote(endpoint)}"))
            assertEquals("\"smoke-model\"", page.eval("return document.querySelector('[aria-label=\"Custom model id\"]').value"))
            assertEquals("true", page.eval("const e=document.querySelector('#provider-vision');if(!e.checked)e.click();return e.checked"))
            page.clickText(".settings-body button", "Save")
            page.await("document.body.innerText.includes('Provider settings saved.')")
            page.click(".settings-head .close-btn")
            if (page.eval("return document.querySelector('.app')?.dataset.sideCollapsed==='false'") == "true")
                page.tap(".titlebar button[title='Sidebar']")
            openCamera(page)
            clickNative { it.contentDescription?.toString() == "Shutter" }
            clickNative { it.contentDescription?.toString() == "Cancel" }
            page.await("!document.querySelector('.composer-image-status[role=status]')")
            assertEquals("0", page.eval("return document.querySelectorAll('.image-attachment').length"))
            openCamera(page)
            clickNative { it.contentDescription?.toString() == "Shutter" }
            clickNative { it.contentDescription?.toString() == "Done" }
            page.await("Array.from(document.querySelectorAll('.image-attachment img')).some(e=>e.complete&&e.naturalWidth>0)", 90)
            page.input("textarea", "SMOKE:android-camera")
            page.await("Array.from(document.querySelectorAll('textarea')).some(e=>e.getClientRects().length&&e.value==='SMOKE:android-camera')")
            page.await("Array.from(document.querySelectorAll('.send-btn')).some(e=>e.getClientRects().length&&!e.disabled)")
            page.awaitDraw()
            screenshot("android-camera-thumbnail.png")
            page.tap(".send-btn")
            page.await("document.body.innerText.includes('LOCAL_OK SMOKE:android-camera')", 90)
            page.await("!document.querySelector('.send-btn[title=stop]')", 90)
            page.await("!document.querySelector('.splash')")
            page.awaitDraw()
            screenshot("android-camera-reply.png")
            assertEquals("false", page.eval("return document.body.innerText.includes('Share processing failed')"))
        }
    }

    private fun openCamera(page: WorkbenchTest.Page) {
        page.tap(".composer-plus-btn[aria-label='Add context']")
        page.tap(".composer-plus-menu .composer-menu-item")
        clickNative { it.text?.toString() == "Camera" }
    }

    private fun clickNative(matches: (AccessibilityNodeInfo) -> Boolean) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20)
        while (System.nanoTime() < deadline) {
            val node = find(instrumentation.uiAutomation.rootInActiveWindow, matches)
            if (node != null) {
                var target: AccessibilityNodeInfo = node
                while (!target.isClickable) target = target.parent ?: break
                if (target.isEnabled && target.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return
            }
            Thread.sleep(100)
        }
        screenshot("android-camera-failure.png")
        throw AssertionError("Expected native camera control was not available")
    }

    private fun find(node: AccessibilityNodeInfo?, matches: (AccessibilityNodeInfo) -> Boolean): AccessibilityNodeInfo? {
        if (node == null) return null
        if (matches(node)) return node
        for (index in 0 until node.childCount) find(node.getChild(index), matches)?.let { return it }
        return null
    }

    private fun screenshot(name: String) {
        val directory = requireNotNull(instrumentation.targetContext.getExternalFilesDir(null))
        File(directory, name).outputStream().use { output ->
            val bitmap = instrumentation.uiAutomation.takeScreenshot()
            try { assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)) }
            finally { bitmap.recycle() }
        }
    }
}
