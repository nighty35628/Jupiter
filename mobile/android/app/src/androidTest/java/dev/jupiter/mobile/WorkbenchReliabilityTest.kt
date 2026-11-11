package dev.jupiter.mobile

import android.content.Intent
import android.graphics.Bitmap
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.UUID
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class WorkbenchReliabilityTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()

    @Test fun longReplyScrollCancellationAndAuthenticationFailureRecoverWithoutSecretLeak() {
        val endpoint = InstrumentationRegistry.getArguments().getString("providerUrl")
            ?: throw AssertionError("Pass an explicit local synthetic providerUrl")
        val uri = java.net.URI(endpoint)
        require(uri.scheme == "http" && uri.host == "127.0.0.1" && uri.port > 0 && uri.path == "/v1")
        ActivityScenario.launch<MainActivity>(Intent(instrumentation.targetContext, MainActivity::class.java)).use { scenario ->
            val page = WorkbenchTest.Page(scenario)
            page.await("document.querySelector('textarea')!==null", 240)
            page.await("!document.querySelector('.splash')")
            page.await("Array.from(document.querySelectorAll('textarea')).some(e=>e.getClientRects().length&&!e.disabled)", 90)
            page.click(".titlebar button[title='Sidebar']")
            page.click(".side-foot .row")
            page.clickText(".settings-card button", "Settings")
            page.clickText(".settings-side button", "Models")
            page.await("document.querySelector('[aria-label=\"Provider base URL\"]')!==null")
            assertEquals("true", page.eval("return document.querySelector('[aria-label=\"Provider base URL\"]').value===${org.json.JSONObject.quote(endpoint)}"))
            assertEquals("\"smoke-model\"", page.eval("return document.querySelector('[aria-label=\"Custom model id\"]').value"))
            page.click(".settings-head .close-btn")
            if (page.eval("return document.querySelector('.app')?.dataset.sideCollapsed==='false'") == "true")
                page.tap(".titlebar button[title='Sidebar']")
            val suffix = UUID.randomUUID().toString()
            send(page, "SMOKE:android-long-transcript-$suffix")
            page.await("document.body.innerText.includes('LOCAL_LINE_240')", 90)
            page.await("!document.querySelector('.send-btn[title=stop]')")
            assertEquals("true", page.eval("const e=Array.from(document.querySelectorAll('.thread [data-virtuoso-scroller]')).find(e=>e.getClientRects().length&&e.clientHeight>0&&e.scrollHeight>e.clientHeight);if(!e)return false;e.scrollTop=Math.max(0,e.scrollTop-240);e.dispatchEvent(new Event('scroll'));return true"))
            page.await("Array.from(document.querySelectorAll('.msg-text')).some(e=>e.getClientRects().length&&e.textContent.includes('LOCAL_LINE_'))")
            page.awaitDraw()
            screenshot("android-long-reply-scrolled.png")
            send(page, "SMOKE:android-cancel-$suffix")
            page.await("document.querySelector('.send-btn[title=stop]')!==null")
            page.awaitDraw()
            page.tap(".send-btn[title=stop]")
            page.await("!document.querySelector('.send-btn[title=stop]')", 10)
            val recovered = "SMOKE:android-recovered-$suffix"
            send(page, recovered)
            page.await("document.body.innerText.includes('LOCAL_OK $recovered')", 90)
            send(page, "SMOKE:android-auth-fault-$suffix")
            page.await("document.body.innerText.includes('synthetic auth denial')", 90)
            page.await("!document.querySelector('.send-btn[title=stop]')", 15)
            assertEquals("false", page.eval("return document.body.innerText.includes('sk-jupiter-isolated-synthetic-20261008-never-real')"))
            val afterFailure = "SMOKE:android-after-failure-$suffix"
            send(page, afterFailure)
            page.await("document.body.innerText.includes('LOCAL_OK $afterFailure')", 90)
            page.await("!document.querySelector('.send-btn[title=stop]')", 90)
            page.awaitDraw()
            screenshot("android-reliability-recovered.png")
        }
    }

    private fun send(page: WorkbenchTest.Page, marker: String) {
        page.await("!document.querySelector('.send-btn[title=stop]')", 20)
        page.input("textarea", marker)
        page.await("Array.from(document.querySelectorAll('.send-btn')).some(e=>e.getClientRects().length&&!e.disabled)")
        page.awaitDraw()
        assertEquals("true", page.eval("return Array.from(document.querySelectorAll('textarea')).some(e=>e.getClientRects().length&&e.value===${org.json.JSONObject.quote(marker)})"))
        page.tap(".send-btn")
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
