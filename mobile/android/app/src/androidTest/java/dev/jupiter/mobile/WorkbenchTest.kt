package dev.jupiter.mobile

import android.content.Intent
import android.graphics.Bitmap
import android.os.SystemClock
import android.view.InputDevice
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Exercises the packaged workbench without enabling WebView remote debugging. */
@RunWith(AndroidJUnit4::class)
class WorkbenchTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()

    @Test fun syntheticProviderUiChatAndDraftSurviveActivityRecreation() {
        val endpoint = InstrumentationRegistry.getArguments().getString("providerUrl")
            ?: throw AssertionError("Pass an explicit local synthetic providerUrl")
        val uri = java.net.URI(endpoint)
        require(uri.scheme == "http" && uri.host == "127.0.0.1" && uri.port > 0 && uri.path == "/v1")
        ActivityScenario.launch<MainActivity>(Intent(instrumentation.targetContext, MainActivity::class.java)).use { scenario ->
            val page = Page(scenario)
            page.await("document.querySelector('textarea,input[type=password]')!==null", 240)
            if (page.eval("return document.documentElement.lang==='en'") != "true") {
                assertEquals("true", page.eval("localStorage.setItem('jupiter.lang','en');return true"))
                scenario.recreate()
                page.await("document.documentElement.lang==='en'&&document.querySelector('textarea,input[type=password]')!==null", 90)
            }
            page.await("!document.querySelector('.splash')")
            page.click(".titlebar button[title='Sidebar']")
            page.click(".side-foot .row")
            page.await("document.querySelector('.settings-card')!==null")
            page.clickText(".settings-card button", "Settings")
            page.await("document.querySelector('.settings-side')!==null")
            page.clickText(".settings-side button", "Models")
            page.await("document.querySelector('[aria-label=\"Provider base URL\"]')!==null")
            page.input("[aria-label='API key']", "sk-jupiter-isolated-synthetic-20261008-never-real")
            page.input("[aria-label='Provider base URL']", endpoint)
            page.input("[aria-label='Custom model id']", "smoke-model")
            page.clickText(".settings-body button", "Save")
            page.await("document.body.innerText.includes('Provider settings saved.')")
            page.clickText(".settings-body button", "Test connection")
            page.await("document.body.innerText.includes('Models endpoint verified.')")
            page.click(".settings-head .close-btn")
            page.await("document.querySelector('textarea')!==null")
            page.input("textarea", "SMOKE:android-instrumented")
            page.await("Array.from(document.querySelectorAll('.send-btn')).some(e=>e.getClientRects().length&&!e.disabled)")
            page.click(".send-btn")
            page.await("document.body.innerText.includes('LOCAL_OK SMOKE:android-instrumented')", 90)
            screenshot("android-instrumented-reply.png")
            page.input("textarea", "ANDROID_DRAFT_NOT_SENT")
            page.await("Array.from(document.querySelectorAll('textarea')).some(e=>e.value==='ANDROID_DRAFT_NOT_SENT')")
            scenario.recreate()
            page.await("Array.from(document.querySelectorAll('textarea')).some(e=>e.value==='ANDROID_DRAFT_NOT_SENT')", 90)
            page.await("document.body.innerText.includes('LOCAL_OK SMOKE:android-instrumented')", 90)
            page.await("!document.querySelector('.splash')")
            screenshot("android-recreated-draft.png")
        }
    }

    private fun screenshot(name: String) {
        val directory = requireNotNull(instrumentation.targetContext.getExternalFilesDir(null))
        File(directory, name).outputStream().use { output ->
            val bitmap = instrumentation.uiAutomation.takeScreenshot()
            try { assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)) }
            finally { bitmap.recycle() }
        }
    }

    internal class Page(val scenario: ActivityScenario<MainActivity>) {
        fun eval(script: String): String {
            val done = CountDownLatch(1)
            var result: String? = null
            var found = false
            scenario.onActivity { activity ->
                val view = findWeb(activity.findViewById(android.R.id.content))
                if (view != null) {
                    found = true
                    view.evaluateJavascript("(()=>{$script})()") { value -> result = value; done.countDown() }
                } else done.countDown()
            }
            assertTrue("WebView evaluation timed out", done.await(10, TimeUnit.SECONDS))
            return if (!found) "null" else result ?: "null"
        }
        fun await(expression: String, seconds: Long = 15) {
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds)
            while (System.nanoTime() < deadline) {
                if (eval("return !!($expression)") == "true") return
                Thread.sleep(100)
            }
            throw AssertionError("Workbench condition timed out: $expression")
        }
        fun click(selector: String) {
            await("Array.from(document.querySelectorAll(${JSONObject.quote(selector)})).some(e=>e.getClientRects().length)")
            assertEquals("true", eval("const e=Array.from(document.querySelectorAll(${JSONObject.quote(selector)})).find(e=>e.getClientRects().length);if(!e)return false;e.click();return true"))
        }
        fun tap(selector: String) {
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15)
            var previous: JSONObject? = null
            var point: JSONObject? = null
            while (System.nanoTime() < deadline) {
                val next = JSONObject(eval("""
                    const e=Array.from(document.querySelectorAll(${JSONObject.quote(selector)})).find(e=>e.getClientRects().length);
                    if(!e)return {visible:false};
                    const r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y);
                    return {visible:!!hit&&e.contains(hit)&&!e.closest('[inert]')&&!e.disabled,x,y,width:window.innerWidth,hit:hit?.tagName+'.'+hit?.className,inert:!!e.closest('[inert]')};
                """.trimIndent()))
                val last = previous
                if (next.optBoolean("visible") && last?.optBoolean("visible") == true &&
                    kotlin.math.abs(next.getDouble("x") - last.getDouble("x")) < 0.5 &&
                    kotlin.math.abs(next.getDouble("y") - last.getDouble("y")) < 0.5) {
                    point = next; break
                }
                previous = next
                Thread.sleep(100)
            }
            val target = point ?: throw AssertionError("Touch target is obscured or moving: $selector ($previous)")
            val location = IntArray(2)
            var width = 0
            scenario.onActivity { activity ->
                val view = requireNotNull(findWeb(activity.findViewById(android.R.id.content)))
                view.getLocationOnScreen(location); width = view.width
            }
            val scale = width / target.getDouble("width")
            val x = (location[0] + target.getDouble("x") * scale).toFloat()
            val y = (location[1] + target.getDouble("y") * scale).toFloat()
            val downTime = SystemClock.uptimeMillis()
            for (action in listOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP)) {
                val event = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), action, x, y, 0)
                event.source = InputDevice.SOURCE_TOUCHSCREEN
                try { assertTrue(InstrumentationRegistry.getInstrumentation().uiAutomation.injectInputEvent(event, true)) }
                finally { event.recycle() }
                if (action == MotionEvent.ACTION_DOWN) Thread.sleep(70)
            }
        }
        fun awaitDraw() {
            val drawn = CountDownLatch(1)
            scenario.onActivity { activity ->
                val view = requireNotNull(findWeb(activity.findViewById(android.R.id.content)))
                view.postVisualStateCallback(SystemClock.uptimeMillis(), object : WebView.VisualStateCallback() {
                    override fun onComplete(requestId: Long) {
                        view.postOnAnimation { view.postOnAnimation { drawn.countDown() } }
                    }
                })
            }
            assertTrue("Workbench did not draw its latest DOM state", drawn.await(10, TimeUnit.SECONDS))
        }
        fun clickText(selector: String, text: String) {
            await("(()=>{const e=Array.from(document.querySelectorAll(${JSONObject.quote(selector)})).find(e=>e.getClientRects().length&&e.textContent.trim()===${JSONObject.quote(text)});if(!e)return false;document.querySelectorAll('[data-qa-text-target]').forEach(n=>n.removeAttribute('data-qa-text-target'));e.setAttribute('data-qa-text-target','true');e.scrollIntoView({block:'center'});return true})()")
            tap("[data-qa-text-target=true]")
        }
        fun input(selector: String, value: String) {
            await("Array.from(document.querySelectorAll(${JSONObject.quote(selector)})).some(e=>e.getClientRects().length)")
            assertEquals("true", eval("const e=Array.from(document.querySelectorAll(${JSONObject.quote(selector)})).find(e=>e.getClientRects().length);if(!e)return false;const p=e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,${JSONObject.quote(value)});e.dispatchEvent(new Event('input',{bubbles:true}));return true"))
        }
        companion object {
            fun findWeb(view: View): WebView? {
                if (view is WebView) return view
                if (view is ViewGroup) for (index in 0 until view.childCount) findWeb(view.getChildAt(index))?.let { return it }
                return null
            }
        }
    }
}
