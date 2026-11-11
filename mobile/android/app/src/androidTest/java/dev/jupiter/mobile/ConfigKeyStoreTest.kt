package dev.jupiter.mobile

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.system.Os
import android.util.Base64
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.security.InvalidAlgorithmParameterException
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ConfigKeyStoreTest {
    private val context: Context = InstrumentationRegistry.getInstrumentation().targetContext
    private val fixtures = mutableListOf<Fixture>()

    private inner class Fixture {
        private val id = UUID.randomUUID().toString()
        val alias = "${context.packageName}.test.config-dek.$id"
        val fileName = "test-config-dek-$id.json"
        val file = File(context.noBackupFilesDir, fileName)
        fun store() = ConfigKeyStore(context, alias = alias, fileName = fileName)
    }

    private fun fixture() = Fixture().also { fixtures.add(it) }

    private fun keyStore() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    @After
    fun cleanUpOnlyGeneratedFixtures() {
        val keys = keyStore()
        var cleanupFailure: Exception? = null
        for (fixture in fixtures) {
            try {
                keys.deleteEntry(fixture.alias)
            } catch (failure: Exception) {
                if (cleanupFailure == null) cleanupFailure = failure
            } finally {
                // API 29 AtomicFile does not necessarily know about the newer .new sidecar.
                for (file in listOf(fixture.file, File(fixture.file.path + ".new"), File(fixture.file.path + ".bak"))) {
                    if (file.exists() && !file.delete() && cleanupFailure == null) {
                        cleanupFailure = IllegalStateException("Could not remove a generated test envelope")
                    }
                }
            }
        }
        cleanupFailure?.let { throw it }
    }

    @Test
    fun reopenReturnsSameDekWithoutRewritingEnvelope() {
        val fixture = fixture()
        val first = fixture.store().loadOrCreate(false)
        try {
            assertEquals(32, first.size)
            val saved = fixture.file.readBytes()
            for (configExists in listOf(false, true)) {
                val reopened = fixture.store().loadOrCreate(configExists)
                try {
                    // Avoid assertion APIs that could print a DEK on failure.
                    assertTrue("Reopened DEK differs", first.contentEquals(reopened))
                    assertFalse(first === reopened)
                    assertArrayEquals(saved, fixture.file.readBytes())
                } finally {
                    reopened.fill(0)
                }
            }
        } finally {
            first.fill(0)
        }
    }

    @Test
    fun storesOnlyWrappedKeyInPrivateNoBackupFile() {
        val fixture = fixture()
        val dek = fixture.store().loadOrCreate(false)
        try {
            assertEquals(context.noBackupFilesDir.canonicalFile, fixture.file.parentFile.canonicalFile)
            assertEquals(384, Os.stat(fixture.file.path).st_mode and 511) // 0600
            val bytes = fixture.file.readBytes()
            assertTrue(bytes.size <= 1024)
            assertFalse("Raw DEK found on disk", bytes.asList().windowed(32).any {
                it.toByteArray().contentEquals(dek)
            })
            val text = bytes.toString(Charsets.UTF_8)
            assertFalse("Base64 DEK found on disk", text.contains(b64(dek)))
            assertFalse("Hex DEK found on disk", text.contains(dek.joinToString("") { "%02x".format(it) }))
            val envelope = JSONObject(text)
            assertEquals(setOf("version", "nonce", "ciphertext", "tag"), envelope.keys().asSequence().toSet())
            assertEquals(1, envelope.getInt("version"))
            for ((field, size) in mapOf("nonce" to 12, "ciphertext" to 32, "tag" to 16)) {
                val encoded = envelope.getString(field)
                val decoded = Base64.decode(encoded, Base64.NO_WRAP)
                assertEquals(size, decoded.size)
                assertEquals(b64(decoded), encoded)
            }
            val key = keyStore().getKey(fixture.alias, null) as SecretKey
            assertNull(key.encoded)
            val info = SecretKeyFactory.getInstance("AES", "AndroidKeyStore")
                .getKeySpec(key, KeyInfo::class.java) as KeyInfo
            assertEquals(256, info.keySize)
            assertEquals(setOf(KeyProperties.BLOCK_MODE_GCM), info.blockModes.toSet())
            assertEquals(setOf(KeyProperties.ENCRYPTION_PADDING_NONE), info.encryptionPaddings.toSet())
            try {
                Cipher.getInstance("AES/GCM/NoPadding").init(
                    Cipher.ENCRYPT_MODE, key, GCMParameterSpec(128, ByteArray(12)),
                )
                fail("Keystore allowed a caller-selected encryption IV")
            } catch (_: InvalidAlgorithmParameterException) {
                // Keystore enforces the randomized-encryption policy used during generation.
            }
            assertFalse(File(fixture.file.path + ".new").exists())
            assertFalse(File(fixture.file.path + ".bak").exists())
        } finally {
            dek.fill(0)
        }
    }

    @Test
    fun existingConfigWithoutEnvelopeNeverCreatesKey() {
        val fixture = fixture()
        assertFailure("missing") { fixture.store().loadOrCreate(true) }
        assertFalse(fixture.file.exists())
        assertFalse(keyStore().containsAlias(fixture.alias))
        generateTestKey(fixture.alias, 256)
        assertFailure("missing") { fixture.store().loadOrCreate(true) }
        assertFalse(fixture.file.exists())
        assertTrue(keyStore().containsAlias(fixture.alias))
    }

    @Test
    fun missingAliasNeverRegeneratesOrOverwritesEnvelope() {
        val fixture = fixture()
        fixture.store().loadOrCreate(false).fill(0)
        val saved = fixture.file.readBytes()
        keyStore().deleteEntry(fixture.alias)
        for (configExists in listOf(false, true)) {
            assertFailure("alias is missing") { fixture.store().loadOrCreate(configExists) }
            assertFalse(keyStore().containsAlias(fixture.alias))
            assertArrayEquals(saved, fixture.file.readBytes())
        }
    }

    @Test
    fun replacedOrWrongSizeAliasNeverOverwritesEnvelopeOrKey() {
        val fixture = fixture()
        fixture.store().loadOrCreate(false).fill(0)
        val saved = fixture.file.readBytes()
        for (bits in listOf(256, 128)) {
            keyStore().deleteEntry(fixture.alias)
            generateTestKey(fixture.alias, bits)
            val replacementKey = keyStore().getKey(fixture.alias, null) as SecretKey
            val proof = Cipher.getInstance("AES/GCM/NoPadding").apply {
                init(Cipher.ENCRYPT_MODE, replacementKey)
            }
            val knownText = byteArrayOf(1, 2, 3)
            val sealedProof = proof.doFinal(knownText)
            assertFailure { fixture.store().loadOrCreate(true) }
            assertArrayEquals(saved, fixture.file.readBytes())
            assertTrue(keyStore().containsAlias(fixture.alias))
            val after = Cipher.getInstance("AES/GCM/NoPadding").apply {
                init(Cipher.DECRYPT_MODE, keyStore().getKey(fixture.alias, null), GCMParameterSpec(128, proof.iv))
            }
            assertArrayEquals(knownText, after.doFinal(sealedProof))
        }
    }

    @Test
    fun rejectsMalformedEnvelopesWithoutOverwriting() {
        val fixture = fixture()
        fixture.store().loadOrCreate(false).fill(0)
        val original = fixture.file.readText()
        fun changed(field: String, value: Any) = JSONObject(original).put(field, value).toString()
        val ciphertext = JSONObject(original).getString("ciphertext")
        val alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
        val padIndex = ciphertext.length - 2
        val nonCanonicalPadBits = ciphertext.substring(0, padIndex) +
            alphabet[alphabet.indexOf(ciphertext[padIndex]) or 1] + "="
        val invalid = mutableListOf(
            "", "{", "null", "[]", original + "{}", original + "junk", original.dropLast(1),
            original.dropLast(1) + ",\"version\":1}",
            original.dropLast(1) + ",\"nonce\":\"AAAAAAAAAAAAAAAA\"}",
            original.replace("\"version\":1", "\"version\":1.0"),
            original.replace("\"version\":1", "\"version\":1e0"),
            original.replace("\"version\":1", "\"version\":\"1\""),
            changed("version", 2), changed("version", -1), changed("extra", true), changed("nonce", JSONObject.NULL),
            changed("tag", true), changed("ciphertext", nonCanonicalPadBits),
            changed("nonce", "_".repeat(16)), changed("nonce", "\u00e9".repeat(16)),
            changed("ciphertext", ciphertext.trimEnd('=')),
            changed("ciphertext", ciphertext + "\n"),
            changed("ciphertext", "!".repeat(44)),
            " ".repeat(1025),
        )
        for ((field, size) in mapOf("nonce" to 12, "ciphertext" to 32, "tag" to 16)) {
            invalid += JSONObject(original).apply { remove(field) }.toString()
            invalid += changed(field, b64(ByteArray(size - 1)))
            invalid += changed(field, b64(ByteArray(size + 1)))
            val tampered = Base64.decode(JSONObject(original).getString(field), Base64.NO_WRAP)
            tampered[0] = (tampered[0].toInt() xor 1).toByte()
            invalid += changed(field, b64(tampered))
        }
        for (text in invalid) {
            fixture.file.writeText(text)
            val saved = fixture.file.readBytes()
            assertFailure { fixture.store().loadOrCreate(false) }
            assertArrayEquals(saved, fixture.file.readBytes())
            assertTrue(keyStore().containsAlias(fixture.alias))
        }
        fixture.file.writeBytes(ByteArray(1025) { 0xff.toByte() })
        assertFailure { fixture.store().loadOrCreate(true) }
        assertEquals(1025L, fixture.file.length())
    }

    @Test
    fun corruptEnvelopeWithoutAliasDoesNotCreateAlias() {
        val fixture = fixture()
        fixture.file.writeText("{}")
        assertFailure { fixture.store().loadOrCreate(false) }
        assertEquals("{}", fixture.file.readText())
        assertFalse(keyStore().containsAlias(fixture.alias))
    }

    @Test
    fun recoversAtomicBackupOfSameDek() {
        val fixture = fixture()
        val original = fixture.store().loadOrCreate(false)
        try {
            val saved = fixture.file.readBytes()
            assertTrue(fixture.file.renameTo(File(fixture.file.path + ".bak")))
            fixture.file.writeText("interrupted write")
            val recovered = fixture.store().loadOrCreate(true)
            try {
                assertTrue("Recovered DEK differs", original.contentEquals(recovered))
                assertArrayEquals(saved, fixture.file.readBytes())
            } finally {
                recovered.fill(0)
            }
        } finally {
            original.fill(0)
        }
    }

    @Test
    fun orphanAtomicNewFileFailsClosed() {
        val fixture = fixture()
        val pending = File(fixture.file.path + ".new")
        pending.writeText("interrupted first write")
        assertFailure { fixture.store().loadOrCreate(false) }
        assertEquals("interrupted first write", pending.readText())
        assertFalse(fixture.file.exists())
        assertFalse(keyStore().containsAlias(fixture.alias))
    }

    @Test
    fun invalidFileNamesCannotEscapeNoBackupDirectory() {
        val fixture = fixture()
        for (name in listOf("", ".", "..", "../elsewhere", "/absolute", "sub/file", "key.new", "key.bak")) {
            try {
                ConfigKeyStore(context, alias = fixture.alias, fileName = name)
                fail("Invalid file name accepted")
            } catch (_: IllegalArgumentException) {
                // Only fixture-owned paths and aliases are ever cleaned up.
            }
        }
        assertFalse(keyStore().containsAlias(fixture.alias))
    }

    private fun generateTestKey(alias: String, bits: Int) {
        KeyGenerator.getInstance("AES", "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setKeySize(bits)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build())
            generateKey()
        }
    }

    private fun assertFailure(messagePart: String? = null, action: () -> ByteArray) {
        try {
            action().fill(0)
            fail("Expected fail-closed key loading")
        } catch (failure: IllegalStateException) {
            if (messagePart != null) assertTrue(failure.message.orEmpty().contains(messagePart))
        }
    }

    private fun b64(bytes: ByteArray) = Base64.encodeToString(bytes, Base64.NO_WRAP)
}
