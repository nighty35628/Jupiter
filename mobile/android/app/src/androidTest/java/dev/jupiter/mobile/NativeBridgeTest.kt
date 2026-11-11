package dev.jupiter.mobile

import android.content.Intent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.UUID
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class NativeBridgeTest {
    @Test fun rejectsStaleMalformedAndBinaryMessagesAndDeduplicatesDialogs() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        ActivityScenario.launch<MainActivity>(Intent(instrumentation.targetContext, MainActivity::class.java)).use { scenario ->
            val page = WorkbenchTest.Page(scenario)
            page.await("window.JupiterAndroid&&document.querySelector('meta[name=\"jupiter-run\"]')", 240)
            assertEquals("true", page.eval("""
                window.__qaReplies=[];
                window.JupiterAndroid.onmessage=e=>{try{window.__qaReplies.push(JSON.parse(e.data))}catch{}};
                window.__qaRun=document.querySelector('meta[name="jupiter-run"]').content;
                window.__qaSend=(id,command,run=window.__qaRun)=>window.JupiterAndroid.postMessage(JSON.stringify({version:1,runId:run,requestId:id,command,args:{}}));
                try{window.JupiterAndroid.postMessage(new Uint8Array([0,1,2]).buffer)}catch{}
                window.JupiterAndroid.postMessage('null');
                window.JupiterAndroid.postMessage('x'.repeat(20000));
                window.__qaSend('11111111-1111-4111-8111-111111111111','notificationPermission','old-run');
                window.__qaSend('22222222-2222-4222-8222-222222222222','notificationStatus');
                return true;
            """.trimIndent()))
            page.await("window.__qaReplies.length===1")
            assertEquals("true", page.eval("return window.__qaReplies[0].requestId==='22222222-2222-4222-8222-222222222222'&&window.__qaReplies[0].ok===true"))
            assertEquals("true", page.eval("window.__qaSend('33333333-3333-4333-8333-333333333333','chooseWorkspace');window.__qaSend('33333333-3333-4333-8333-333333333333','chooseWorkspace');window.__qaSend('44444444-4444-4444-8444-444444444444','consumeShare');return true"))
            page.await("window.__qaReplies.some(e=>e.requestId==='44444444-4444-4444-8444-444444444444')")
            assertEquals("true", page.eval("const e=window.__qaReplies.find(e=>e.requestId==='44444444-4444-4444-8444-444444444444');return e.ok===true&&e.result===null"))
            val deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(10)
            var cancel: AccessibilityNodeInfo? = null
            while (cancel == null && System.nanoTime() < deadline) {
                cancel = instrumentation.uiAutomation.rootInActiveWindow?.findAccessibilityNodeInfosByText("CANCEL")?.firstOrNull { it.isClickable }
                if (cancel == null) Thread.sleep(100)
            }
            assertNotNull("Native project dialog was not drawn", cancel)
            assertTrue(cancel!!.performAction(AccessibilityNodeInfo.ACTION_CLICK))
            page.await("window.__qaReplies.length===3")
            assertEquals("true", page.eval("window.__qaSend('33333333-3333-4333-8333-333333333333','chooseWorkspace');return true"))
            page.await("window.__qaReplies.length===4")
            assertEquals("true", page.eval("const a=window.__qaReplies.filter(e=>e.requestId==='33333333-3333-4333-8333-333333333333');return a.length===2&&JSON.stringify(a[0])===JSON.stringify(a[1])"))
            assertTrue("Completed duplicate reopened the native dialog", instrumentation.uiAutomation.rootInActiveWindow?.findAccessibilityNodeInfosByText("CANCEL").orEmpty().none { it.isClickable })
            scenario.recreate()
            page.await("document.querySelector('textarea,input[type=password]')!==null", 90)
        }
    }

    @Test fun pendingShareDefersWhileDialogIsOpenAndNotifiesOnlyOnceAfterFinish() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val directory = File(instrumentation.targetContext.cacheDir, "native-shares").canonicalFile
        val store = NativeShareStore(directory)
        val intake = UUID.randomUUID().toString()
        assertNull("This isolated test requires an empty native share queue", store.first())
        try {
            ActivityScenario.launch<MainActivity>(Intent(instrumentation.targetContext, MainActivity::class.java)).use { scenario ->
                val page = WorkbenchTest.Page(scenario)
                page.await("document.readyState==='complete'&&window.JupiterAndroid&&document.querySelector('meta[name=\"jupiter-run\"]')&&typeof window.JupiterAndroid.onmessage==='function'&&!document.querySelector('.splash')&&!!document.querySelector('textarea')", 240)
                    // This checks Native deferral, not React intake (covered by AttachmentWorkflowTest).
                assertEquals("true", page.eval("""
                    window.dispatchEvent(new Event('pagehide'));
                    window.__qaReplies=[];window.__qaReady=0;
                    window.addEventListener('jupiter:android-share-ready',e=>{window.__qaReady++;e.stopImmediatePropagation()},true);
                    const receiver=window.JupiterAndroid.onmessage;
                    window.JupiterAndroid.onmessage=e=>{receiver?.call(window.JupiterAndroid,e);try{window.__qaReplies.push(JSON.parse(e.data))}catch{}};
                    window.__qaRun=document.querySelector('meta[name="jupiter-run"]').content;
                    window.__qaSend=(id,command)=>window.JupiterAndroid.postMessage(JSON.stringify({version:1,runId:window.__qaRun,requestId:id,command,args:{}}));
                    window.__qaSend('55555555-5555-4555-8555-555555555555','chooseWorkspace');return true;
                """.trimIndent()))
                val firstCancel = awaitCancelButton()
                store.enqueue(intake, "QA_DEFERRED_SHARE_NOT_SUBMITTED", emptyList(), null)
                assertEquals("true", page.eval("""
                    window.__qaReady=0;
                    window.__qaSend('66666666-6666-4666-8666-666666666666','consumeShare');
                    window.__qaSend('77777777-7777-4777-8777-777777777777','consumeShare');return true;
                """.trimIndent()))
                page.await("['66666666-6666-4666-8666-666666666666','77777777-7777-4777-8777-777777777777'].every(id=>window.__qaReplies.some(e=>e.requestId===id&&e.ok===true&&e.result===null))")
                assertEquals("0", page.eval("return window.__qaReady"))
                assertEquals(intake, store.first()!!.id)
                assertFalse("Busy consume must not stage a share", File(directory, "$intake/files").exists())
                assertTrue(firstCancel.performAction(AccessibilityNodeInfo.ACTION_CLICK))
                page.await("window.__qaReady===1&&window.__qaReplies.some(e=>e.requestId==='55555555-5555-4555-8555-555555555555')")
                assertEquals("true", page.eval("window.__qaSend('88888888-8888-4888-8888-888888888888','consumeShare');return true"))
                try {
                    page.await("window.__qaReplies.some(e=>e.requestId==='88888888-8888-4888-8888-888888888888'&&e.ok===true&&e.result&&e.result.id==='${intake}')")
                } catch (failure: AssertionError) {
                    throw AssertionError("Synthetic share replies: " + page.eval("return JSON.stringify(window.__qaReplies.map(e=>({requestId:e.requestId,ok:e.ok,error:e.error,resultId:e.result?.id,isNull:e.result===null})))"), failure)
                }
                assertEquals("1", page.eval("return window.__qaReady"))
                assertEquals(intake, store.first()!!.id)
                assertEquals("true", page.eval("window.__qaSend('99999999-9999-4999-8999-999999999999','chooseWorkspace');return true"))
                assertTrue(awaitCancelButton().performAction(AccessibilityNodeInfo.ACTION_CLICK))
                page.await("window.__qaReplies.some(e=>e.requestId==='99999999-9999-4999-8999-999999999999')")
                assertEquals("1", page.eval("return window.__qaReady"))
            }
        } finally {
            if (store.first()?.id == intake) store.discard(intake) { true }
        }
    }

    private fun awaitCancelButton(): AccessibilityNodeInfo {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(10)
        while (System.nanoTime() < deadline) {
            val cancel = instrumentation.uiAutomation.rootInActiveWindow?.findAccessibilityNodeInfosByText("CANCEL")?.firstOrNull { it.isClickable }
            if (cancel != null) return cancel
            Thread.sleep(100)
        }
        throw AssertionError("Native project dialog was not drawn")
    }
}
