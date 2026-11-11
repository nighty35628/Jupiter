package dev.jupiter.mobile

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.system.Os
import android.util.AtomicFile
import android.util.Base64
import android.util.JsonReader
import android.util.JsonToken
import java.io.File
import java.io.StringReader
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec

/**
 * Wraps only the 32-byte Node config DEK, not provider credentials or config JSON.
 * The caller must deliver the returned bytes only through trusted native stdin,
 * then clear them in finally. Never pass them to env, argv, logs, or a WebView bridge.
 * Calls are serialized within this process; the native host must be the sole process owner.
 */
class ConfigKeyStore(
    context: Context,
    private val alias: String = "${context.packageName}.jupiter.config.dek.v1",
    fileName: String = "jupiter-config-dek-v1.json",
) {
    init {
        require(alias.isNotBlank() && alias.length <= 256) { "Invalid config key alias" }
        require(fileName.length <= 128 && FILE_NAME.matches(fileName) &&
            !fileName.endsWith(".new") && !fileName.endsWith(".bak")) {
            "Invalid config key file name"
        }
    }

    private val file = File(context.noBackupFilesDir, fileName)
    private val atomicFile = AtomicFile(file)
    private val aad = "Jupiter/ConfigKeyStore/v1\u0000${context.packageName}\u0000$alias\u0000$fileName"
        .toByteArray(Charsets.UTF_8)

    /** Missing/damaged state is an error, never an implicit reset of an existing config. */
    fun loadOrCreate(configAlreadyExists: Boolean): ByteArray = synchronized(LOCK) {
        try {
            loadOrCreateLocked(configAlreadyExists)
        } catch (failure: StoreFailure) {
            throw failure
        } catch (_: Exception) {
            // Provider/parser exceptions must not expose input material through their messages.
            throw StoreFailure("Config DEK could not be loaded or persisted; no reset was performed.")
        }
    }

    private fun loadOrCreateLocked(configAlreadyExists: Boolean): ByteArray {
        // AtomicFile may have a recoverable legacy backup or an interrupted first write.
        val wrappedExists = file.exists() || File(file.path + ".bak").exists() ||
            File(file.path + ".new").exists()
        if (!wrappedExists && configAlreadyExists) {
            throw StoreFailure("Wrapped config DEK is missing for an existing config.")
        }
        val envelope = if (wrappedExists) readEnvelope() else null
        val keys = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        val key = if (keys.containsAlias(alias)) {
            keys.getKey(alias, null) as? SecretKey
                ?: throw StoreFailure("Config Keystore alias is damaged or is not an AES key.")
        } else {
            if (wrappedExists) throw StoreFailure("Config Keystore alias is missing for a wrapped DEK.")
            generateWrappingKey()
        }
        validateWrappingKey(key)
        if (envelope != null) return unwrap(key, envelope)

        val dek = ByteArray(DEK_BYTES)
        try {
            SecureRandom().nextBytes(dek)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            // Keystore supplies a fresh randomized IV; caller-selected encryption IVs are forbidden.
            cipher.init(Cipher.ENCRYPT_MODE, key)
            cipher.updateAAD(aad)
            val sealed = cipher.doFinal(dek)
            val nonce = cipher.iv
            if (nonce.size != NONCE_BYTES || sealed.size != DEK_BYTES + TAG_BYTES) {
                throw StoreFailure("Unexpected config DEK wrapping parameters.")
            }
            val ciphertext = sealed.copyOfRange(0, DEK_BYTES)
            val tag = sealed.copyOfRange(DEK_BYTES, sealed.size)
            val encoded = ("{\"version\":1,\"nonce\":\"${encode(nonce)}\"," +
                "\"ciphertext\":\"${encode(ciphertext)}\",\"tag\":\"${encode(tag)}\"}")
                .toByteArray(Charsets.US_ASCII)
            persist(encoded)
            return dek
        } catch (failure: Exception) {
            dek.fill(0)
            throw failure
        }
    }

    private fun generateWrappingKey(): SecretKey = KeyGenerator.getInstance("AES", KEYSTORE).run {
        init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setKeySize(256)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)
            .build())
        generateKey()
    }

    private fun validateWrappingKey(key: SecretKey) {
        if (key.algorithm != "AES") throw StoreFailure("Config Keystore alias is not an AES-256-GCM key.")
        val info = SecretKeyFactory.getInstance("AES", KEYSTORE)
            .getKeySpec(key, KeyInfo::class.java) as KeyInfo
        val purposes = KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
        if (info.keySize != 256 || info.purposes and purposes != purposes ||
            KeyProperties.BLOCK_MODE_GCM !in info.blockModes ||
            KeyProperties.ENCRYPTION_PADDING_NONE !in info.encryptionPaddings) {
            throw StoreFailure("Config Keystore alias is not an AES-256-GCM wrapping key.")
        }
    }

    private fun unwrap(key: SecretKey, envelope: Envelope): ByteArray {
        try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BYTES * 8, envelope.nonce))
            cipher.updateAAD(aad)
            val dek = cipher.doFinal(envelope.ciphertext + envelope.tag)
            if (dek.size != DEK_BYTES) {
                dek.fill(0)
                throw StoreFailure("Invalid unwrapped config DEK length.")
            }
            return dek
        } catch (_: Exception) {
            throw StoreFailure("Wrapped config DEK authentication failed or Keystore key is unavailable.")
        }
    }

    private fun readEnvelope(): Envelope {
        try {
            val bytes = readBounded()
            if (bytes.isEmpty() || bytes.any { it.toInt() < 0 }) throw StoreFailure(INVALID_ENVELOPE)
            JsonReader(StringReader(bytes.toString(Charsets.US_ASCII))).use { reader ->
                reader.isLenient = false
                reader.beginObject()
                val fields = mutableMapOf<String, String>()
                var versionSeen = false
                while (reader.hasNext()) {
                    val name = reader.nextName()
                    if (name == "version") {
                        if (versionSeen || reader.peek() != JsonToken.NUMBER || reader.nextString() != "1") {
                            throw StoreFailure("Unsupported or invalid wrapped config DEK version.")
                        }
                        versionSeen = true
                    } else {
                        if (name !in ENCODED_FIELDS || fields.containsKey(name) || reader.peek() != JsonToken.STRING) {
                            throw StoreFailure(INVALID_ENVELOPE)
                        }
                        fields[name] = reader.nextString()
                    }
                }
                reader.endObject()
                if (!versionSeen || fields.size != 3 || reader.peek() != JsonToken.END_DOCUMENT) {
                    throw StoreFailure(INVALID_ENVELOPE)
                }
                return Envelope(
                    decode(fields.getValue("nonce"), NONCE_BYTES),
                    decode(fields.getValue("ciphertext"), DEK_BYTES),
                    decode(fields.getValue("tag"), TAG_BYTES),
                )
            }
        } catch (failure: StoreFailure) {
            throw failure
        } catch (_: Exception) {
            throw StoreFailure(INVALID_ENVELOPE)
        }
    }

    private fun readBounded(): ByteArray = atomicFile.openRead().use { input ->
        val buffer = ByteArray(MAX_ENVELOPE_BYTES + 1)
        var count = 0
        while (count < buffer.size) {
            val read = input.read(buffer, count, buffer.size - count)
            if (read == -1) break
            count += read
        }
        if (count > MAX_ENVELOPE_BYTES) throw StoreFailure("Wrapped config DEK file exceeds its size limit.")
        buffer.copyOf(count)
    }

    private fun persist(bytes: ByteArray) {
        val output = atomicFile.startWrite()
        try {
            Os.fchmod(output.fd, 384) // 0600: only this app UID may read/write the envelope.
            output.write(bytes)
            output.fd.sync()
        } catch (failure: Exception) {
            atomicFile.failWrite(output)
            throw failure
        }
        atomicFile.finishWrite(output)
        // AtomicFile can log rather than throw on commit errors. Do not return an unpersisted DEK.
        if (!readBounded().contentEquals(bytes)) {
            throw StoreFailure("Wrapped config DEK could not be committed.")
        }
    }

    private fun encode(bytes: ByteArray) = Base64.encodeToString(bytes, Base64.NO_WRAP)

    private fun decode(text: String, size: Int): ByteArray {
        if (text.length != ((size + 2) / 3) * 4) throw StoreFailure(INVALID_ENVELOPE)
        val bytes = Base64.decode(text, Base64.NO_WRAP)
        if (bytes.size != size || encode(bytes) != text) throw StoreFailure(INVALID_ENVELOPE)
        return bytes
    }

    private data class Envelope(val nonce: ByteArray, val ciphertext: ByteArray, val tag: ByteArray)
    private class StoreFailure(message: String) : IllegalStateException(message)

    private companion object {
        const val KEYSTORE = "AndroidKeyStore"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val DEK_BYTES = 32
        const val NONCE_BYTES = 12
        const val TAG_BYTES = 16
        const val MAX_ENVELOPE_BYTES = 1024
        const val INVALID_ENVELOPE = "Wrapped config DEK is invalid or damaged."
        val ENCODED_FIELDS = setOf("nonce", "ciphertext", "tag")
        val FILE_NAME = Regex("[A-Za-z0-9][A-Za-z0-9._-]*")
        val LOCK = Any()
    }
}
