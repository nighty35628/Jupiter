package dev.jupiter.mobile

import org.junit.Assert.*
import org.junit.Test

class SpeechSessionControllerTest {
    private class FakeHost : SpeechSessionController.Host {
        var foreground = true
        var unlocked = true
        var permission = true
        var capabilities = SpeechCapabilities(true, true)
        var permissionRequests = 0
        var permissionCallback: ((Boolean) -> Unit)? = null
        val recognizers = mutableListOf<FakeRecognizer>()
        var createFailure = false
        var now = 0L
        private data class Task(val due: Long, val action: () -> Unit, var cancelled: Boolean = false)
        private val tasks = mutableListOf<Task>()
        override fun capabilities() = capabilities
        override fun foreground() = foreground
        override fun unlocked() = unlocked
        override fun hasPermission() = permission
        override fun requestPermission(result: (Boolean) -> Unit) {
            check(permissionCallback == null)
            permissionRequests++
            permissionCallback = result
        }
        fun grant(granted: Boolean = true) {
            permission = granted
            val callback = permissionCallback
            permissionCallback = null
            callback?.invoke(granted)
        }
        override fun create(mode: String, languageTag: String, listener: SpeechSessionController.Listener): SpeechSessionController.Recognizer {
            check(!createFailure)
            return FakeRecognizer(mode, languageTag, listener).also { recognizers.add(it) }
        }
        override fun schedule(delayMs: Long, task: () -> Unit): () -> Unit {
            val entry = Task(now + delayMs, task)
            tasks.add(entry)
            return { entry.cancelled = true }
        }
        fun advance(ms: Long) {
            val target = now + ms
            while (true) {
                val next = tasks.filter { !it.cancelled && it.due <= target }.minByOrNull { it.due } ?: break
                tasks.remove(next)
                now = next.due
                next.action()
            }
            now = target
        }
    }
    private class FakeRecognizer(val mode: String, val language: String, val listener: SpeechSessionController.Listener) : SpeechSessionController.Recognizer {
        var starts = 0
        var finishes = 0
        var cancels = 0
        var destroys = 0
        var failFinish = false
        var onCancel: (() -> Unit)? = null
        override fun start() { starts++ }
        override fun finish() { finishes++; check(!failFinish) }
        override fun cancel() { cancels++; onCancel?.invoke() }
        override fun destroy() { destroys++ }
    }
    private class Fixture {
        val host = FakeHost()
        val controller = SpeechSessionController(host)
        val events = mutableListOf<SpeechEvent>()
        var authorized = true
        fun start(id: String = "s1", language: String = "en", mode: String = "local") =
            controller.start(id, language, mode, { authorized }, events::add)
        val recognizer get() = host.recognizers.last()
        val listener get() = recognizer.listener
        val states get() = events.map { it.state }
        fun ready() { assertNull(start()); listener.ready() }
        fun released() { assertEquals(1, recognizer.cancels); assertEquals(1, recognizer.destroys) }
    }

    @Test fun capabilityVersionGuardDoesNotCallOnDeviceApiBefore31() {
        for (sdk in listOf(29, 30)) {
            val capability = SpeechCapabilities.detect(sdk, { error("API 31 only") }, { true })
            assertFalse(capability.localAvailable)
            assertTrue(capability.networkAvailable)
            assertTrue(capability.available)
        }
        assertEquals(SpeechCapabilities(true, false), SpeechCapabilities.detect(31, { true }, { false }))
        assertFalse(SpeechCapabilities.detect(36, { error("No service") }, { error("No service") }).available)
    }

    @Test fun explicitLanguageCodesMapToLocalesWithoutUiLanguageOrAuto() {
        val locales = mapOf("zh" to "zh-CN", "en" to "en-US", "ja" to "ja-JP", "ko" to "ko-KR",
            "de" to "de-DE", "fr" to "fr-FR", "es" to "es-ES", "ru" to "ru-RU", "yue" to "yue-HK")
        locales.forEach { (code, tag) -> assertEquals(tag, SpeechSessionController.languageTag(code)) }
        assertEquals("en-US", SpeechSessionController.languageTag("EN"))
        assertEquals("it", SpeechSessionController.languageTag("it"))
        for (invalid in listOf("auto", "", "en-US", "not-a-language", " en"))
            assertNull(SpeechSessionController.languageTag(invalid))
    }

    @Test fun validatesRequestBeforePermissionOrRecognizerAllocation() {
        val f = Fixture(); f.host.permission = false
        for (id in listOf("", "bad id", "../s", "a".repeat(129))) assertNotNull(f.start(id))
        assertNotNull(f.start(language = "auto"))
        assertNotNull(f.start(mode = "cloud"))
        assertEquals(0, f.host.permissionRequests)
        assertTrue(f.host.recognizers.isEmpty())
    }

    @Test fun rejectsBackgroundLockedAndUnauthorizedStarts() {
        val f = Fixture()
        f.host.foreground = false; assertNotNull(f.start())
        f.host.foreground = true; f.host.unlocked = false; assertNotNull(f.start())
        f.host.unlocked = true; f.authorized = false; assertNotNull(f.start())
        assertTrue(f.host.recognizers.isEmpty())
    }

    @Test fun localModeNeverFallsBackToSystem() {
        val f = Fixture(); f.host.capabilities = SpeechCapabilities(false, true)
        assertNotNull(f.start(mode = "local"))
        assertTrue(f.host.recognizers.isEmpty())
        assertNull(f.start(mode = "system"))
        assertEquals("system", f.recognizer.mode)
        assertEquals("en-US", f.recognizer.language)
        f.controller.cancelCurrent()
        f.host.capabilities = SpeechCapabilities(true, false)
        assertNotNull(f.start(mode = "system"))
        assertNull(f.start(language = "zh", mode = "local"))
        assertEquals("local", f.recognizer.mode)
        assertEquals("zh-CN", f.recognizer.language)
    }

    @Test fun busyStartCannotReplaceTheCurrentSession() {
        val f = Fixture(); f.ready()
        assertNotNull(f.start("s2"))
        assertFalse(f.controller.cancel("s2"))
        assertFalse(f.controller.finish("s2"))
        assertEquals(1, f.host.recognizers.size)
        assertEquals(0, f.recognizer.cancels)
    }

    @Test fun partialAndFinalResultsAreDistinctAndFinalIsDeliveredOnce() {
        val f = Fixture(); f.ready()
        f.listener.partial("hello")
        assertTrue(f.controller.finish("s1"))
        assertTrue(f.controller.finish("s1"))
        f.listener.partial("ignored while transcribing")
        f.listener.ended()
        f.listener.result("hello world")
        f.listener.result("duplicate")
        f.listener.error("late error")
        f.host.advance(100_000)
        assertEquals(listOf("preparing", "recording", "recording", "transcribing", "result"), f.states)
        assertEquals("hello", f.events[2].text)
        assertEquals("hello world", f.events.last().text)
        assertEquals(1, f.recognizer.finishes)
        f.released()
    }

    @Test fun providerEndStartsBoundedTranscriptionWithoutAnotherStopCall() {
        val f = Fixture(); f.ready()
        f.listener.ended(); f.listener.ended()
        assertEquals(0, f.recognizer.finishes)
        f.host.advance(14_999)
        assertEquals("transcribing", f.states.last())
        f.host.advance(1)
        assertEquals("error", f.states.last())
        assertTrue(f.events.last().error!!.contains("timed out"))
        f.released()
    }

    @Test fun sixtySecondLimitFinishesWithoutSendingOrRestarting() {
        val f = Fixture(); f.ready()
        f.host.advance(59_999)
        assertEquals(0, f.recognizer.finishes)
        f.host.advance(1)
        assertEquals(1, f.recognizer.finishes)
        assertEquals("transcribing", f.states.last())
        f.listener.result("bounded recording")
        f.host.advance(100_000)
        assertEquals(1, f.host.recognizers.size)
        f.released()
    }

    @Test fun readinessAndPermissionWaitsHaveTimeouts() {
        val f = Fixture(); assertNull(f.start())
        f.host.advance(10_000)
        assertEquals("error", f.states.last())
        f.released()
        val p = Fixture(); p.host.permission = false; assertNull(p.start())
        p.host.advance(30_000); p.host.grant()
        assertEquals(listOf("preparing", "error"), p.states)
        assertTrue(p.host.recognizers.isEmpty())
    }

    @Test fun cancelInvalidatesBeforeProviderCancelCanCallBack() {
        val f = Fixture(); f.ready()
        f.recognizer.onCancel = { f.listener.result("must not escape"); f.listener.error("late") }
        assertTrue(f.controller.cancel("s1"))
        assertFalse(f.controller.cancel("s1"))
        f.host.advance(100_000)
        assertEquals(listOf("preparing", "recording", "cancelled"), f.states)
        f.released()
    }

    @Test fun oldCallbacksCannotAffectAnotherSessionEvenWithReusedId() {
        val f = Fixture(); f.ready(); val old = f.listener
        f.controller.cancelCurrent(); assertNull(f.start()); f.listener.ready()
        old.ready(); old.partial("old"); old.ended(); old.result("old"); old.error("old")
        f.listener.result("new")
        assertEquals(listOf("new"), f.events.filter { it.state == "result" }.map { it.text })
        assertEquals(1, f.host.recognizers[0].destroys)
        assertEquals(1, f.host.recognizers[1].destroys)
    }

    @Test fun permissionDenialDoesNotAllocateARecognizer() {
        val f = Fixture(); f.host.permission = false; assertNull(f.start())
        f.host.grant(false)
        assertEquals(listOf("preparing", "error"), f.states)
        assertTrue(f.events.last().error!!.contains("denied"))
        assertTrue(f.host.recognizers.isEmpty())
    }

    @Test fun permissionRoundTripDefersRecordingUntilForegroundResume() {
        val f = Fixture(); f.host.permission = false; assertNull(f.start())
        f.host.foreground = false; f.controller.onPause()
        f.host.grant(); f.host.advance(1_000)
        assertEquals(listOf("preparing"), f.states)
        assertTrue(f.host.recognizers.isEmpty())
        f.host.foreground = true; f.controller.onResume()
        assertEquals(1, f.recognizer.starts)
        f.listener.ready(); f.controller.cancelCurrent(); f.controller.onResume()
        assertEquals(1, f.host.recognizers.size)
    }

    @Test fun cancelledPermissionApprovalCannotRestartOrCancelANewerRecording() {
        val f = Fixture(); f.host.permission = false; assertNull(f.start())
        f.controller.cancelCurrent()
        f.host.permission = true; assertNull(f.start("s2")); f.listener.ready()
        f.host.grant()
        f.listener.result("new session")
        assertEquals(listOf("s2"), f.events.filter { it.state == "result" }.map { it.sessionId })
        assertEquals(1, f.host.recognizers.size)
    }

    @Test fun pendingOldPermissionDialogDoesNotAuthorizeANewRequest() {
        val f = Fixture(); f.host.permission = false; assertNull(f.start())
        f.controller.cancelCurrent(); assertNull(f.start("s2"))
        assertEquals("error", f.states.last())
        f.host.grant()
        assertTrue(f.host.recognizers.isEmpty())
        assertEquals(1, f.host.permissionRequests)
    }

    @Test fun finishingDuringPermissionWaitDiscardsRatherThanStartingLater() {
        val f = Fixture(); f.host.permission = false; assertNull(f.start())
        assertTrue(f.controller.finish("s1")); f.host.grant()
        assertEquals(listOf("preparing", "cancelled"), f.states)
        assertTrue(f.host.recognizers.isEmpty())
    }

    @Test fun permissionReturnRechecksAuthorizationAndLock() {
        for (locked in listOf(true, false)) {
            val f = Fixture(); f.host.permission = false; assertNull(f.start())
            if (locked) f.host.unlocked = false else f.authorized = false
            f.host.grant(); f.controller.onResume()
            assertTrue(f.host.recognizers.isEmpty())
            assertFalse(f.states.contains("recording"))
        }
    }

    @Test fun backgroundDestroyAndPageReplacementReleaseWithoutRestart() {
        for (reason in listOf("pause", "destroy", "page", "lock", "permission")) {
            val f = Fixture(); f.ready(); val old = f.listener
            when (reason) {
                "pause" -> { f.host.foreground = false; f.controller.onPause() }
                "destroy" -> f.controller.cancelCurrent()
                "page" -> f.authorized = false
                "lock" -> f.host.unlocked = false
                "permission" -> f.host.permission = false
            }
            f.host.advance(500); old.result("stale")
            f.host.foreground = true; f.host.unlocked = true; f.host.permission = true; f.authorized = true
            f.controller.onResume(); f.host.advance(100_000)
            assertTrue(f.events.none { it.state == "result" })
            assertEquals(1, f.host.recognizers.size)
            f.released()
        }
    }

    @Test fun stoppedPermissionRequestAndActivityRecreationCannotRecordFromLateGrant() {
        val f = Fixture(); f.host.permission = false; assertNull(f.start())
        f.host.foreground = false; f.controller.onPause(); f.controller.cancelCurrent()
        val replacement = SpeechSessionController(f.host)
        f.host.grant(); f.host.foreground = true; replacement.onResume(); f.controller.onResume()
        assertTrue(f.host.recognizers.isEmpty())
        assertEquals(listOf("preparing", "cancelled"), f.states)
    }

    @Test fun recognizerFailuresAndUnsupportedLanguagesTerminateWithoutRetry() {
        for (message in listOf("Speech recognizer is busy", "No speech was detected", "Speech provider network is unavailable",
            "Selected language is not supported", "Selected language is not installed")) {
            val f = Fixture(); f.ready(); f.listener.error(message); f.listener.result("late")
            f.host.advance(100_000)
            assertEquals(message, f.events.last().error)
            assertEquals(1, f.host.recognizers.size)
            f.released()
        }
        val f = Fixture(); f.host.createFailure = true; assertNull(f.start())
        assertEquals(listOf("preparing", "error"), f.states)
        assertTrue(f.host.recognizers.isEmpty())
        val g = Fixture(); g.ready(); g.recognizer.failFinish = true; g.controller.finish("s1")
        assertEquals("error", g.states.last()); g.released()
    }

    @Test fun silenceAndOversizedResultsAreNotAcceptedAndPartialsAreBounded() {
        for (text in listOf(null, "", "   ", "a".repeat(SpeechSessionController.MAX_TEXT + 1))) {
            val f = Fixture(); f.ready()
            f.listener.partial("a".repeat(SpeechSessionController.MAX_TEXT + 100))
            assertEquals(SpeechSessionController.MAX_TEXT, f.events.last().text!!.length)
            f.listener.result(text)
            assertEquals("error", f.states.last())
            assertEquals(0, f.events.count { it.state == "result" })
            f.released()
        }
    }
}
