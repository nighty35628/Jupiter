package dev.jupiter.mobile

import java.util.Locale

internal data class SpeechCapabilities(val localAvailable: Boolean, val networkAvailable: Boolean) {
    val available get() = localAvailable || networkAvailable

    companion object {
        fun detect(sdk: Int, onDevice: () -> Boolean, system: () -> Boolean) = SpeechCapabilities(
            sdk >= 31 && runCatching(onDevice).getOrDefault(false), runCatching(system).getOrDefault(false))
    }
}

internal data class SpeechEvent(val sessionId: String, val state: String, val text: String? = null, val error: String? = null)

/** Main-thread session ownership, independent of Android so stale callbacks can be tested on the JVM. */
internal class SpeechSessionController(private val host: Host) {
    interface Host {
        fun capabilities(): SpeechCapabilities
        fun foreground(): Boolean
        fun unlocked(): Boolean
        fun hasPermission(): Boolean
        fun requestPermission(result: (Boolean) -> Unit)
        fun create(mode: String, languageTag: String, listener: Listener): Recognizer
        fun schedule(delayMs: Long, task: () -> Unit): () -> Unit
    }
    interface Recognizer {
        fun start()
        fun finish()
        fun cancel()
        fun destroy()
    }
    interface Listener {
        fun ready()
        fun partial(text: String?)
        fun ended()
        fun result(text: String?)
        fun error(message: String)
    }
    private class Session(val id: String, val mode: String, val language: String,
                          val authorized: () -> Boolean, val emit: (SpeechEvent) -> Unit) {
        var state = "preparing"
        var permissionRoundTrip = false
        var permissionGranted = false
        var recognizer: Recognizer? = null
        var stageTimer: (() -> Unit)? = null
        var limitTimer: (() -> Unit)? = null
        var guardTimer: (() -> Unit)? = null
    }
    private var current: Session? = null

    fun start(id: String, language: String, mode: String, authorized: () -> Boolean, emit: (SpeechEvent) -> Unit): String? {
        if (!validSessionId(id)) return "Invalid speech session ID"
        val tag = languageTag(language) ?: return "Select a supported manual language; automatic language is unavailable"
        if (mode != "local" && mode != "system") return "Invalid speech mode"
        if (current != null) return "Speech recognition is already busy"
        if (!authorized() || !host.foreground() || !host.unlocked()) return "Speech requires the current foreground, unlocked workbench"
        val capabilities = host.capabilities()
        if (mode == "local" && !capabilities.localAvailable) return "On-device speech recognition is unavailable"
        if (mode == "system" && !capabilities.networkAvailable) return "System speech recognition is unavailable"
        val session = Session(id, mode, tag, authorized, emit)
        current = session
        emit(session, "preparing")
        if (host.hasPermission()) begin(session)
        else {
            session.permissionRoundTrip = true
            stageTimeout(session, 30_000, "Microphone permission timed out")
            try {
                host.requestPermission { granted ->
                    if (current !== session) return@requestPermission
                    if (!granted || !host.hasPermission()) terminate(session, "error", error = "Microphone permission denied")
                    else if (!session.authorized() || !host.unlocked()) terminate(session, "cancelled")
                    else {
                        session.permissionGranted = true
                        // Permission results may arrive before onResume. Never start from that callback while paused.
                        if (host.foreground()) begin(session)
                    }
                }
            } catch (_: Exception) { terminate(session, "error", error = "Microphone permission request is unavailable or already pending") }
        }
        guard(session)
        return null
    }

    fun finish(id: String): Boolean {
        val session = current?.takeIf { it.id == id } ?: return false
        if (!usable(session)) return false
        if (session.recognizer == null) terminate(session, "cancelled")
        else if (session.state != "transcribing") {
            transcribing(session)
            try { session.recognizer?.finish() }
            catch (_: Exception) { terminate(session, "error", error = "Speech recognition could not finish") }
        }
        return true
    }

    fun cancel(id: String): Boolean {
        val session = current?.takeIf { it.id == id } ?: return false
        terminate(session, "cancelled")
        return true
    }

    fun cancelCurrent() { current?.let { terminate(it, "cancelled") } }
    fun onPause() { current?.takeUnless { it.permissionRoundTrip }?.let { terminate(it, "cancelled") } }
    fun onResume() {
        val session = current ?: return
        if (session.permissionRoundTrip && session.permissionGranted) begin(session)
    }

    private fun begin(session: Session) {
        if (!usable(session, requirePermission = true, requireForeground = true)) return
        session.permissionRoundTrip = false
        session.stageTimer?.invoke()
        try {
            val recognizer = host.create(session.mode, session.language, object : Listener {
                override fun ready() {
                    if (!usable(session, requirePermission = true) || session.state != "preparing") return
                    session.stageTimer?.invoke(); session.stageTimer = null
                    emit(session, "recording")
                }
                override fun partial(text: String?) {
                    if (usable(session, requirePermission = true) && session.state == "recording" && !text.isNullOrBlank())
                        emit(session, "recording", text.take(MAX_TEXT))
                }
                override fun ended() {
                    if (usable(session, requirePermission = true) && session.state != "transcribing") transcribing(session)
                }
                override fun result(text: String?) {
                    if (!usable(session, requirePermission = true)) return
                    if (text.isNullOrBlank()) terminate(session, "error", error = "No speech was recognized")
                    else if (text.length > MAX_TEXT) terminate(session, "error", error = "Speech result exceeds its size limit")
                    else terminate(session, "result", text = text)
                }
                override fun error(message: String) {
                    if (usable(session)) terminate(session, "error", error = message.take(512))
                }
            })
            session.recognizer = recognizer
            stageTimeout(session, 10_000, "Speech recognizer did not become ready")
            session.limitTimer = host.schedule(60_000) { if (current === session) finish(session.id) }
            recognizer.start()
        } catch (_: Exception) { terminate(session, "error", error = "Speech recognizer could not start in the selected mode") }
    }

    private fun usable(session: Session, requirePermission: Boolean = false, requireForeground: Boolean = true): Boolean {
        if (current !== session) return false
        if (!session.authorized() || !host.unlocked() || (requireForeground && !host.foreground())) {
            terminate(session, "cancelled"); return false
        }
        if (requirePermission && !host.hasPermission()) {
            terminate(session, "error", error = "Microphone permission was revoked"); return false
        }
        return true
    }

    private fun guard(session: Session) {
        if (current !== session) return
        session.guardTimer = host.schedule(500) {
            if (usable(session, requirePermission = session.recognizer != null, requireForeground = !session.permissionRoundTrip)) guard(session)
        }
    }

    private fun transcribing(session: Session) {
        session.limitTimer?.invoke(); session.limitTimer = null
        stageTimeout(session, 15_000, "Speech recognition result timed out")
        emit(session, "transcribing")
    }

    private fun stageTimeout(session: Session, delay: Long, message: String) {
        session.stageTimer?.invoke()
        session.stageTimer = host.schedule(delay) { if (current === session) terminate(session, "error", error = message) }
    }

    private fun emit(session: Session, state: String, text: String? = null) {
        session.state = state
        if (session.authorized()) runCatching { session.emit(SpeechEvent(session.id, state, text)) }
    }

    private fun terminate(session: Session, state: String, text: String? = null, error: String? = null) {
        if (current !== session) return
        // Invalidate first: cancel/destroy can synchronously dispatch callbacks on some providers.
        current = null
        session.stageTimer?.invoke(); session.limitTimer?.invoke(); session.guardTimer?.invoke()
        val recognizer = session.recognizer
        session.recognizer = null
        runCatching { recognizer?.cancel() }
        runCatching { recognizer?.destroy() }
        if (session.authorized()) runCatching { session.emit(SpeechEvent(session.id, state, text, error)) }
    }

    companion object {
        const val MAX_TEXT = 32_768
        fun validSessionId(id: String) = Regex("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}").matches(id)
        private val languages = Locale.getISOLanguages().toSet()
        private val locales = mapOf("zh" to "zh-CN", "en" to "en-US", "ja" to "ja-JP", "ko" to "ko-KR",
            "de" to "de-DE", "fr" to "fr-FR", "es" to "es-ES", "ru" to "ru-RU", "yue" to "yue-HK")
        fun languageTag(code: String): String? {
            val normalized = code.lowercase(Locale.ROOT)
            return locales[normalized] ?: normalized.takeIf { it in languages }
        }
    }
}
