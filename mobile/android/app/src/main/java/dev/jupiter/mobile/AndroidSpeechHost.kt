package dev.jupiter.mobile

import android.Manifest
import android.app.KeyguardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts

internal class AndroidSpeechHost(private val activity: ComponentActivity, private val resumed: () -> Boolean) : SpeechSessionController.Host {
    private val handler = Handler(Looper.getMainLooper())
    private var permissionResult: ((Boolean) -> Unit)? = null
    private val permission = activity.registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val callback = permissionResult
        permissionResult = null
        callback?.invoke(granted)
    }

    private fun mainThread() { check(Looper.myLooper() == Looper.getMainLooper()) }
    override fun capabilities(): SpeechCapabilities {
        mainThread()
        return SpeechCapabilities.detect(Build.VERSION.SDK_INT,
            { Build.VERSION.SDK_INT >= 31 && SpeechRecognizer.isOnDeviceRecognitionAvailable(activity) },
            { SpeechRecognizer.isRecognitionAvailable(activity) })
    }
    override fun foreground() = resumed() && !activity.isFinishing && !activity.isDestroyed
    override fun unlocked() = !activity.getSystemService(KeyguardManager::class.java).isKeyguardLocked &&
        activity.getSystemService(PowerManager::class.java).isInteractive
    override fun hasPermission() = activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
    override fun requestPermission(result: (Boolean) -> Unit) {
        mainThread()
        check(permissionResult == null) { "A microphone permission dialog is still pending" }
        permissionResult = result
        try { permission.launch(Manifest.permission.RECORD_AUDIO) }
        catch (error: Exception) { permissionResult = null; throw error }
    }
    override fun schedule(delayMs: Long, task: () -> Unit): () -> Unit {
        mainThread()
        val runnable = Runnable(task)
        handler.postDelayed(runnable, delayMs)
        return { handler.removeCallbacks(runnable) }
    }
    override fun create(mode: String, languageTag: String, listener: SpeechSessionController.Listener): SpeechSessionController.Recognizer {
        mainThread()
        // Only this factory guarantees local mode. Never substitute the system provider or PREFER_OFFLINE.
        val recognizer = if (mode == "local") {
            if (Build.VERSION.SDK_INT >= 31) {
                check(SpeechRecognizer.isOnDeviceRecognitionAvailable(activity))
                SpeechRecognizer.createOnDeviceSpeechRecognizer(activity)
            } else error("On-device recognition requires Android API 31")
        } else SpeechRecognizer.createSpeechRecognizer(activity)
        try {
            recognizer.setRecognitionListener(object : RecognitionListener {
                override fun onReadyForSpeech(params: Bundle?) = listener.ready()
                override fun onBeginningOfSpeech() = listener.ready()
                override fun onRmsChanged(rmsdB: Float) {}
                override fun onBufferReceived(buffer: ByteArray?) {}
                override fun onEndOfSpeech() = listener.ended()
                override fun onError(error: Int) = listener.error(errorMessage(error))
                override fun onResults(results: Bundle?) = listener.result(text(results))
                override fun onPartialResults(partialResults: Bundle?) = listener.partial(text(partialResults))
                override fun onEvent(eventType: Int, params: Bundle?) {}
            })
        } catch (error: Exception) { recognizer.destroy(); throw error }
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE, languageTag)
            .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
        return object : SpeechSessionController.Recognizer {
            override fun start() { mainThread(); recognizer.startListening(intent) }
            override fun finish() { mainThread(); recognizer.stopListening() }
            override fun cancel() { mainThread(); recognizer.cancel() }
            override fun destroy() { mainThread(); recognizer.destroy() }
        }
    }

    private fun text(bundle: Bundle?): String? = bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()

    private fun errorMessage(code: Int) = when (code) {
        SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "Speech provider network request timed out"
        SpeechRecognizer.ERROR_NETWORK -> "Speech provider network is unavailable"
        SpeechRecognizer.ERROR_AUDIO -> "Microphone audio capture failed"
        SpeechRecognizer.ERROR_SERVER, SpeechRecognizer.ERROR_SERVER_DISCONNECTED -> "Speech provider is unavailable"
        SpeechRecognizer.ERROR_CLIENT -> "Speech recognition request failed"
        SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "No speech was detected"
        SpeechRecognizer.ERROR_NO_MATCH -> "No speech was recognized"
        SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "Speech recognizer is busy"
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Microphone permission denied or revoked"
        SpeechRecognizer.ERROR_TOO_MANY_REQUESTS -> "Speech provider request limit reached"
        SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED -> "Selected language is not supported by this speech provider"
        SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE -> "Selected language is not installed or currently available"
        else -> "Speech recognition failed ($code)"
    }
}
