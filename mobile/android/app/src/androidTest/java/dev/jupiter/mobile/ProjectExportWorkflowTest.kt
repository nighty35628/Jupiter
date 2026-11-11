package dev.jupiter.mobile

import android.content.Intent
import android.accessibilityservice.AccessibilityService
import android.os.Bundle
import android.view.KeyEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.UUID
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Requires the synthetic imported Git project with the Agent-created long-a.txt. */
@RunWith(AndroidJUnit4::class)
class ProjectExportWorkflowTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()

    @Test fun editedProjectFileExportsThroughSafAndCancellationRemainsUsable() {
        ActivityScenario.launch<MainActivity>(Intent(instrumentation.targetContext, MainActivity::class.java)).use { scenario ->
            val page = WorkbenchTest.Page(scenario)
            page.await("document.querySelector('textarea')!==null", 240)
            page.await("!document.querySelector('.splash')")
            page.await("document.querySelector('.tabbar [aria-label=\"mobile-project-git\"]')!==null", 90)
            page.tap(".tabbar [aria-label='mobile-project-git']")
            page.await("document.querySelector('.tabbar [aria-label=\"mobile-project-git\"]')?.getAttribute('aria-selected')==='true'")
            page.await("Array.from(document.querySelectorAll('textarea')).some(e=>e.getClientRects().length&&!e.disabled)", 90)
            page.awaitDraw()
            assertEquals("true", page.eval("""
                window.__qaCtxTrace=[];
                const stamp=(event)=>{
                  const e=document.querySelector('.ctx');
                  const entry={time:performance.now(),event,mode:e?.dataset.mode,tab:document.querySelector('.tabbar [aria-selected=true]')?.getAttribute('aria-label'),drawer:document.querySelector('.app')?.dataset.webDrawerOpen,collapsed:document.querySelector('.app')?.dataset.ctxCollapsed};
                  let f=e&&e[Object.keys(e).find(k=>k.startsWith('__reactFiber'))];
                  while(f){if(f.memoizedProps?.tabId&&f.memoizedProps?.registerDispatch){let h=f.memoizedState;for(let i=0;h&&i<150;i++,h=h.next){const s=h.memoizedState;if(s&&typeof s==='object'&&'currentSession'in s)entry.runtime={session:s.currentSession,workspace:s.settings?.workspaceDir,ready:s.ready};if(s&&Array.isArray(s.tabs)&&'activeId'in s)entry.context={active:s.activeId,modes:s.tabs.map(t=>t.mode)}}break}f=f.return}
                  window.__qaCtxTrace.push(entry);
                };
                document.addEventListener('click',e=>stamp({click:e.target?.closest('button')?.className||e.target?.className,trusted:e.isTrusted}),true);
                let last='';new MutationObserver(()=>{const value=document.querySelector('.ctx')?.dataset.mode+':'+document.querySelector('.app')?.dataset.ctxCollapsed;if(value!==last){last=value;stamp('context-change')}}).observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['data-mode','data-ctx-collapsed']});
                stamp('start');return true;
            """.trimIndent()))
            if (page.eval("return document.querySelector('.app')?.dataset.sideCollapsed==='false'") == "true")
                page.tap(".titlebar button[title='Sidebar']")
            if (page.eval("return document.querySelector('.app')?.dataset.ctxCollapsed==='false'") != "true")
                page.tap("button[title='Toggle right sidebar']")
            page.await("document.querySelector('.app')?.dataset.ctxCollapsed==='false'&&!!document.querySelector('.ctx:not([inert])')")
            if (page.eval("return !!document.querySelector('.ctx[data-mode=files]')") != "true") {
                if (page.eval("return !!document.querySelector('.ctx-home-card')") == "true") {
                    page.tap(".ctx-home-card")
                } else {
                    page.tap(".ctx .ctx-tab-add")
                    page.tap(".ctx-tab-menu button")
                }
            }
            page.await("!!document.querySelector('.ctx[data-mode=files]')")
            page.awaitDraw()
            try {
                page.input(".ctx-file-search input", "long-a.txt")
                page.await("document.querySelector('[data-jupiter-file-path$=\"long-a.txt\"]')!==null", 30)
            } catch (failure: AssertionError) {
                val state = page.eval("return JSON.stringify({panel:document.querySelector('.ctx')?.innerText,trace:window.__qaCtxTrace})")
                throw AssertionError("Synthetic project file was not found: $state", failure)
            }
            openSaveMenu(page)
            page.tap(".file-action-menu button:nth-of-type(2)")
            val name = "jupiter-edited-${UUID.randomUUID()}.txt"
            val edit = awaitNative { isPickerEdit(it) }
            val args = Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, name) }
            assertTrue(edit.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args))
            awaitNative { isPickerEdit(it) && it.text?.toString() == name }
            clickNative(awaitNative { isPicker(it) && it.viewIdResourceName == "android:id/button1" })
            page.await("!document.querySelector('.file-action-menu')", 60)
            val directory = requireNotNull(instrumentation.targetContext.getExternalFilesDir(null))
            File(directory, "android-project-export.json").writeText(JSONObject().put("name", name).put("expectedFixture", "contentA").toString())
            println("JUPITER_EXPORT_NAME=$name")
            openSaveMenu(page)
            page.tap(".file-action-menu button:nth-of-type(2)")
            awaitNative { isPickerEdit(it) }
            // The first system Back may dismiss the keyboard rather than the document picker.
            repeat(3) {
                if (isPicker(instrumentation.uiAutomation.rootInActiveWindow)) {
                    assertTrue(instrumentation.uiAutomation.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK))
                    Thread.sleep(500)
                }
            }
            page.await("document.querySelector('.file-action-menu [role=status]')?.textContent.includes('cancel')", 20)
            assertEquals("false", page.eval("return document.querySelector('.file-action-menu button:nth-of-type(2)').disabled"))
            assertEquals("false", page.eval("return !!document.querySelector('.file-action-menu [role=alert]')"))
        }
    }

    private fun isPicker(node: AccessibilityNodeInfo?): Boolean =
        node?.packageName?.toString() in setOf("com.android.documentsui", "com.google.android.documentsui")

    private fun isPickerEdit(node: AccessibilityNodeInfo): Boolean =
        isPicker(node) && node.className?.toString() == "android.widget.EditText" &&
            node.isEditable && node.viewIdResourceName == "android:id/title"

    private fun openSaveMenu(page: WorkbenchTest.Page) {
        assertEquals("true", page.eval("const e=document.querySelector('[data-jupiter-file-path$=\"long-a.txt\"]');if(!e)return false;const r=e.getBoundingClientRect();e.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:r.left+20,clientY:r.top+10}));return true"))
        page.await("document.querySelector('.file-action-menu')?.textContent.includes('Save File')")
    }

    private fun clickNative(node: AccessibilityNodeInfo) {
        var target = node
        while (!target.isClickable) target = target.parent ?: break
        assertTrue(target.performAction(AccessibilityNodeInfo.ACTION_CLICK))
    }

    private fun awaitNative(matches: (AccessibilityNodeInfo) -> Boolean): AccessibilityNodeInfo {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20)
        while (System.nanoTime() < deadline) {
            find(instrumentation.uiAutomation.rootInActiveWindow, matches)?.let { return it }
            Thread.sleep(100)
        }
        throw AssertionError("SAF export control was not available")
    }

    private fun find(node: AccessibilityNodeInfo?, matches: (AccessibilityNodeInfo) -> Boolean): AccessibilityNodeInfo? {
        if (node == null) return null
        if (matches(node)) return node
        for (index in 0 until node.childCount) find(node.getChild(index), matches)?.let { return it }
        return null
    }
}
