package dev.jupiter.mobile

import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.attribute.FileTime
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.UUID
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class NativeShareStoreTest {
    @get:Rule val temporary = TemporaryFolder()
    private val root: File get() = File(temporary.root.canonicalFile, "shares")
    private val sourceUri = "content://sender/document/private-name"
    private fun id() = UUID.randomUUID().toString()
    private fun source(bytes: String = "data") = NativeShareStore.Source("../folder/file.txt", "text/plain; charset=utf-8", bytes.byteInputStream())

    @Test
    fun readsWithoutDequeuingAndAcknowledgesOnlyTheConsumedHead() {
        val store = NativeShareStore(root)
        val first = id(); val second = id()
        store.enqueue(first, "draft", listOf(sourceUri), "text/plain")
        store.enqueue(second, "next", emptyList(), null)
        val consumed = store.stage(first, { source() }, { true })
        assertEquals(first, store.first()!!.id)
        assertThrows(IllegalArgumentException::class.java) { store.acknowledge(consumed, second) { true } }
        assertEquals(first, store.first()!!.id)
        store.acknowledge(consumed, first) { true }
        assertEquals(second, store.first()!!.id)
        assertFalse(File(root, first).exists())
        assertTrue(File(root, ".seen-$first").isFile)
    }

    @Test
    fun sameIntakeTokenSurvivesRecreationAndCannotResurrectAfterAcknowledgement() {
        val intake = id()
        NativeShareStore(root).enqueue(intake, "text", listOf(sourceUri), null)
        val recreated = NativeShareStore(root)
        recreated.enqueue(intake, "text", listOf(sourceUri), null)
        assertTrue(recreated.containsIntake(intake))
        val share = recreated.stage(intake, { source() }, { true })
        val restored = NativeShareStore(root).stage(intake, { error("Staged copies must not reopen the provider") }, { true })
        assertEquals(share, restored)
        recreated.acknowledge(share, intake) { true }
        NativeShareStore(root).enqueue(intake, "text", listOf(sourceUri), null)
        assertNull(NativeShareStore(root).first())
    }

    @Test
    fun rejectsReuseOfAnIntakeTokenForAnotherPayload() {
        val store = NativeShareStore(root); val intake = id()
        store.enqueue(intake, "one", emptyList(), null)
        assertThrows(IllegalArgumentException::class.java) { store.enqueue(intake, "two", emptyList(), null) }
        assertEquals("one", store.first()!!.text)
    }

    @Test
    fun stagesOnlyPrivateOpaqueFilesWithSafeMetadata() {
        val store = NativeShareStore(root); val intake = id()
        store.enqueue(intake, "draft only", listOf(sourceUri), "text/plain")
        val share = store.stage(intake, { source() }, { true })
        val file = share.files.single()
        assertTrue(NativeShareStore.isId(file.id))
        assertNotEquals(intake, file.id)
        assertEquals("file.txt", file.name)
        assertEquals("text/plain", file.mime)
        assertEquals(4L, file.size)
        assertFalse(share.toString().contains(sourceUri))
        assertArrayEquals("data".toByteArray(), store.open(share, file.id).use { it.readBytes() })
        assertThrows(IllegalArgumentException::class.java) { store.open(share, "../pending") }
        assertThrows(IOException::class.java) { store.open(share, id()) }
    }

    @Test
    fun textOnlyShareHasNoFilesAndDoesNotOpenAnyProvider() {
        val store = NativeShareStore(root); val intake = id()
        store.enqueue(intake, "text", emptyList(), null)
        val share = store.stage(intake, { error("No provider for text-only shares") }, { true })
        assertEquals("text", share.text)
        assertTrue(share.files.isEmpty())
    }

    @Test
    fun rejectsNonContentUrisOversizedListsAndEmptyIntakes() {
        val store = NativeShareStore(root)
        for (uri in listOf("file:///private/file", "http://127.0.0.1/file", "content:///no-provider", "content://user@provider/path")) {
            assertThrows(IllegalArgumentException::class.java) { store.enqueue(id(), "", listOf(uri), null) }
        }
        assertThrows(IllegalArgumentException::class.java) { store.enqueue(id(), "", List(13) { "$sourceUri/$it" }, null) }
        assertThrows(IllegalArgumentException::class.java) { store.enqueue(id(), "", emptyList(), null) }
        assertNull(store.first())
    }

    @Test
    fun boundsTextWithoutSplittingASurrogatePair() {
        val prefix = "a".repeat(NativeShareStore.MAX_TEXT_CHARS - 1)
        assertEquals(prefix, NativeShareStore.boundText(prefix + "\uD83D\uDE00tail"))
        assertEquals("", NativeShareStore.boundText(null))
    }

    @Test
    fun enforcesAggregateActualBytesAndKeepsTheIntakeOnFailure() {
        val store = NativeShareStore(root, 5); val intake = id()
        store.enqueue(intake, "", listOf(sourceUri, "content://other/file"), null)
        assertThrows(IOException::class.java) { store.stage(intake, { source("abc") }, { true }) }
        assertEquals(intake, store.first()!!.id)
        assertEquals(listOf("pending"), File(root, intake).list()!!.toList())
        assertEquals(100L * 1024 * 1024, NativeShareStore.MAX_BYTES)
    }

    @Test
    fun acceptsExactAggregateLimit() {
        val store = NativeShareStore(root, 6); val intake = id()
        store.enqueue(intake, "", listOf(sourceUri, "content://other/file"), null)
        assertEquals(6L, store.stage(intake, { source("abc") }, { true }).files.sumOf { it.size })
    }

    @Test
    fun providerFailurePreservesTheQueuedIntake() {
        val store = NativeShareStore(root); val intake = id()
        store.enqueue(intake, "", listOf(sourceUri), null)
        assertThrows(IOException::class.java) { store.stage(intake, { throw IOException("private provider error") }, { true }) }
        assertEquals(intake, NativeShareStore(root).first()!!.id)
        assertEquals(listOf("pending"), File(root, intake).list()!!.toList())
    }

    @Test
    fun runRevocationDuringAReadCleansOnlyTheAttemptAndDoesNotReplayIt() {
        val store = NativeShareStore(root); val intake = id()
        val authorization = RunAuthorization("old")
        store.enqueue(intake, "", listOf(sourceUri), null)
        var closed = false
        val input = object : ByteArrayInputStream("data".toByteArray()) {
            override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
                val count = super.read(buffer, offset, length)
                authorization.revoke()
                return count
            }
            override fun close() { closed = true; super.close() }
        }
        assertThrows(IOException::class.java) {
            store.stage(intake, { NativeShareStore.Source("file", null, input) }) { authorization.permits("old", "ready", "old") }
        }
        assertTrue(closed)
        assertEquals(intake, store.first()!!.id)
        assertEquals(listOf("pending"), File(root, intake).list()!!.toList())
    }

    @Test
    fun acknowledgementRequiresLiveAuthorizationAndKeepsPendingOnCancellation() {
        val store = NativeShareStore(root); val intake = id()
        store.enqueue(intake, "", listOf(sourceUri), null)
        val share = store.stage(intake, { source() }, { true })
        assertThrows(IOException::class.java) { store.acknowledge(share, intake) { false } }
        assertEquals(share, store.stage(intake, { error("Keep the staged copy") }, { true }))
    }

    @Test
    fun explicitConsumeCanRepairAnInterruptedAcknowledgementWithoutDroppingTheHead() {
        val store = NativeShareStore(root); val intake = id()
        store.enqueue(intake, "", listOf(sourceUri), null)
        val share = store.stage(intake, { source() }, { true })
        File(File(File(root, intake), "files"), share.files.single().id).delete()
        val repaired = NativeShareStore(root).stage(intake, { source("restored") }, { true })
        assertEquals(intake, repaired.id)
        assertArrayEquals("restored".toByteArray(), store.open(repaired, repaired.files.single().id).use { it.readBytes() })
        assertEquals(intake, store.first()!!.id)
    }

    @Test
    fun discardingAfterGrantFailureUnblocksOnlyTheHeadAndPreservesBothSeenIds() {
        val store = NativeShareStore(root); val failed = id(); val next = id()
        store.enqueue(failed, "", listOf(sourceUri), null)
        store.enqueue(next, "next", emptyList(), null)
        val nextJournal = File(root, "$next/pending").readBytes()
        assertThrows(IOException::class.java) { store.stage(failed, { throw IOException("Grant expired") }, { true }) }
        assertTrue(store.discard(failed) { true })
        assertEquals(next, store.first()!!.id)
        assertArrayEquals(nextJournal, File(root, "$next/pending").readBytes())
        assertFalse(File(root, failed).exists())
        assertTrue(File(root, ".seen-$failed").isFile)
        assertTrue(File(root, ".seen-$next").isFile)
        NativeShareStore(root).enqueue(failed, "", listOf(sourceUri), null)
        assertEquals(next, NativeShareStore(root).first()!!.id)
    }

    @Test
    fun discardingAfterSizeFailureNeverReopensTheSourceOrResurrectsTheIntake() {
        val store = NativeShareStore(root, 2); val failed = id()
        store.enqueue(failed, "", listOf(sourceUri), null)
        var opens = 0
        assertThrows(IOException::class.java) { store.stage(failed, { opens++; source("too big") }, { true }) }
        assertTrue(store.discard(failed) { true })
        assertEquals(1, opens)
        assertNull(store.first())
        val recreated = NativeShareStore(root, 2)
        recreated.enqueue(failed, "", listOf(sourceUri), null)
        assertTrue(recreated.containsIntake(failed))
        assertNull(recreated.first())
    }

    @Test
    fun discardingStagedAndPartialNativeCopiesDoesNotFollowLinksOrDeleteOriginals() {
        val original = temporary.newFile("original.txt").apply { writeText("keep") }
        val store = NativeShareStore(root); val head = id(); val next = id()
        store.enqueue(head, "", listOf(sourceUri), null)
        store.enqueue(next, "next", emptyList(), null)
        store.stage(head, { NativeShareStore.Source("original.txt", "text/plain", original.inputStream()) }, { true })
        val partial = File(root, "$head/.stage-interrupted").apply { mkdir() }
        File(partial, "native-copy").writeText("partial")
        Files.createSymbolicLink(File(partial, "link").toPath(), original.toPath())
        assertTrue(store.discard(head) { true })
        assertFalse(File(root, head).exists())
        assertEquals("keep", original.readText())
        assertEquals(next, store.first()!!.id)
    }

    @Test
    fun cancelledDiscardKeepsTheJournalAndStagedCopy() {
        val store = NativeShareStore(root); val head = id()
        store.enqueue(head, "", listOf(sourceUri), null)
        val staged = store.stage(head, { source() }, { true })
        assertThrows(IOException::class.java) { store.discard(head) { false } }
        assertEquals(head, store.first()!!.id)
        assertEquals(staged, store.stage(head, { error("Keep the existing staged copy") }, { true }))
        assertTrue(File(root, ".seen-$head").isFile)
    }

    @Test
    fun staleOrMismatchedDiscardCannotDeleteTheNextHead() {
        val store = NativeShareStore(root); val head = id(); val next = id()
        store.enqueue(head, "first", emptyList(), null)
        store.enqueue(next, "next", emptyList(), null)
        assertFalse(store.discard(next) { true })
        assertEquals(head, store.first()!!.id)
        assertThrows(IllegalArgumentException::class.java) { store.discard("../pending") { true } }
        assertTrue(store.discard(head) { true })
        assertFalse(store.discard(head) { true })
        assertEquals(next, store.first()!!.id)
    }

    @Test
    fun revocationDuringDiscardKeepsTheJournalAndNextEntryForAnExplicitRetry() {
        val store = NativeShareStore(root); val head = id(); val next = id()
        store.enqueue(head, "", listOf(sourceUri), null)
        store.enqueue(next, "next", emptyList(), null)
        val staged = store.stage(head, { source() }, { true })
        val nativeCopy = File(root, "$head/files/${staged.files.single().id}")
        assertThrows(IOException::class.java) { store.discard(head) { nativeCopy.exists() } }
        assertEquals(head, store.first()!!.id)
        assertTrue(File(root, ".seen-$head").isFile)
        assertTrue(File(root, "$next/pending").isFile)
        assertTrue(store.discard(head) { true })
        assertEquals(next, store.first()!!.id)
    }

    @Test
    fun discardingAnAbsentHeadIsANoOp() {
        val store = NativeShareStore(root)
        assertFalse(store.discard(id()) { true })
        assertFalse(root.exists())
    }

    @Test
    fun pendingCountCapRejectsOnlyNewIntakesAndDuplicatesStillWorkAtCapacity() {
        val limits = NativeShareStore.QueueLimits(maxPending = 2)
        val store = NativeShareStore(root, queueLimits = limits)
        val first = id(); val second = id()
        store.enqueue(first, "first", emptyList(), null)
        store.enqueue(second, "second", emptyList(), null)
        NativeShareStore(root, queueLimits = limits).enqueue(first, "first", emptyList(), null)
        assertThrows(IOException::class.java) { store.enqueue(id(), "rejected", emptyList(), null) }
        assertEquals(first, store.first()!!.id)
        assertTrue(File(root, "$second/pending").isFile)
        assertTrue(root.list()!!.none { it.startsWith(".intake-") })
        assertTrue(store.discard(first) { true })
        store.enqueue(id(), "capacity recovered", emptyList(), null)
        assertEquals(second, store.first()!!.id)
    }

    @Test
    fun aggregateByteBudgetIncludesMetadataAndReservesUntrustedFileBytes() {
        val first = id()
        NativeShareStore(root, 5).enqueue(first, "", listOf(sourceUri), null)
        val metadata = File(root, "$first/pending").length()
        val limits = NativeShareStore.QueueLimits(maxPendingBytes = metadata + NativeShareStore.MAX_MANIFEST_BYTES + 6)
        val store = NativeShareStore(root, 5, limits)
        assertThrows(IOException::class.java) { store.enqueue(id(), "", listOf("content://other/file"), null) }
        assertEquals(first, store.first()!!.id)
        val share = store.stage(first, { source() }, { true })
        assertEquals(4L, share.files.single().size)
    }

    @Test
    fun olderOverBudgetQueueCanDrainInOrderWhileNewOverBudgetIntakesAreRejected() {
        val oldLimits = NativeShareStore.QueueLimits(maxPending = 32, maxPendingBytes = 1024L * 1024 * 1024)
        val old = NativeShareStore(root, queueLimits = oldLimits)
        val intakes = List(6) { id() }
        intakes.forEachIndexed { index, intake -> old.enqueue(intake, "legacy-$index", listOf("$sourceUri/$index"), null) }
        val upgraded = NativeShareStore(root)
        assertThrows(IOException::class.java) { upgraded.enqueue(id(), "new over budget", listOf(sourceUri), null) }
        intakes.forEach { intake ->
            assertEquals(intake, upgraded.first()!!.id)
            val share = upgraded.stage(intake, { source("x") }, { true })
            assertEquals(1L, share.files.single().size)
            assertArrayEquals(byteArrayOf('x'.code.toByte()), upgraded.open(share, share.files.single().id).use { it.readBytes() })
            upgraded.acknowledge(share, intake) { true }
            assertFalse(File(root, intake).exists())
        }
        assertNull(upgraded.first())
        val next = id()
        upgraded.enqueue(next, "new within budget", listOf(sourceUri), null)
        assertEquals(next, upgraded.first()!!.id)
    }

    @Test
    fun metadataAloneCannotBypassTheGlobalByteBudget() {
        val store = NativeShareStore(root, queueLimits = NativeShareStore.QueueLimits(maxPendingBytes = 1))
        assertThrows(IOException::class.java) { store.enqueue(id(), "text", emptyList(), null) }
        assertNull(store.first())
    }

    @Test
    fun completedReceiptsHaveABoundedCountWithoutDeletingPendingIntakes() {
        val limits = NativeShareStore.QueueLimits(maxCompletedReceipts = 2)
        val store = NativeShareStore(root, queueLimits = limits)
        repeat(6) {
            val intake = id()
            store.enqueue(intake, "text", emptyList(), null)
            store.acknowledge(store.stage(intake, { error("No files") }, { true }), intake) { true }
        }
        val pending = id()
        store.enqueue(pending, "keep pending", emptyList(), null)
        assertEquals(pending, store.first()!!.id)
        assertTrue(File(root, ".seen-$pending").isFile)
        assertTrue(root.list()!!.count { it.startsWith(".seen-") } <= 3)
    }

    @Test
    fun lastLaunchIntakeSurvivesReceiptExpiryAndColdRecreation() {
        var now = 10_000L
        val limits = NativeShareStore.QueueLimits(receiptTtlMillis = 100)
        val store = NativeShareStore(root, queueLimits = limits, nowMillis = { now })
        val intake = id()
        store.enqueue(intake, "text", emptyList(), null)
        store.discard(intake) { true }
        Files.setLastModifiedTime(File(root, ".seen-$intake").toPath(), FileTime.fromMillis(0))
        now += 1_000
        val recreated = NativeShareStore(root, queueLimits = limits, nowMillis = { now })
        recreated.enqueue(intake, "text", emptyList(), null)
        assertTrue(recreated.containsIntake(intake))
        assertNull(recreated.first())
        val next = id()
        recreated.enqueue(next, "next launch", emptyList(), null)
        assertFalse("Only the last launch token is pinned indefinitely", File(root, ".seen-$intake").exists())
        assertTrue(File(root, "$next/pending").isFile)
    }

    @Test
    fun retryCleansAbandonedStagingBeforeSpendingTheSameReservationAgain() {
        val store = NativeShareStore(root, 5); val intake = id()
        store.enqueue(intake, "", listOf(sourceUri), null)
        val abandoned = File(root, "$intake/.stage-abandoned").apply { mkdir() }
        File(abandoned, "partial").writeBytes(ByteArray(5))
        assertEquals(4L, store.stage(intake, { source() }, { true }).files.single().size)
        assertFalse("An abandoned copy must not accumulate beyond the reserved budget", abandoned.exists())
    }

    @Test
    fun anotherStoreCannotDeleteOrDuplicateAnActiveStagingAttempt() {
        val store = NativeShareStore(root); val intake = id()
        store.enqueue(intake, "", listOf(sourceUri), null)
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        val worker = Executors.newSingleThreadExecutor()
        val input = object : ByteArrayInputStream("data".toByteArray()) {
            override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
                entered.countDown(); check(release.await(2, TimeUnit.SECONDS))
                return super.read(buffer, offset, length)
            }
        }
        val future = worker.submit<NativeShareStore.Share> { store.stage(intake, { NativeShareStore.Source("file", null, input) }, { true }) }
        try {
            assertTrue(entered.await(1, TimeUnit.SECONDS))
            val other = NativeShareStore(root)
            other.enqueue(intake, "", listOf(sourceUri), null)
            assertThrows(IOException::class.java) { other.stage(intake, { source() }, { true }) }
            assertThrows(IOException::class.java) { other.discard(intake) { true } }
            assertTrue(File(root, ".seen-$intake").isFile)
        } finally { release.countDown(); worker.shutdown(); assertTrue(worker.awaitTermination(3, TimeUnit.SECONDS)) }
        assertEquals(intake, future.get().id)
    }

    @Test
    fun fileUrlRequiresExactOriginOpaqueIdAndTheShareHeader() {
        val share = id(); val file = id(); val origin = "http://127.0.0.1:54321"
        val url = "$origin/native-share/$file"
        assertEquals(file, NativeShareStore.requestedFile(url, origin, share, share))
        for (token in listOf(null, "", id())) assertNull(NativeShareStore.requestedFile(url, origin, share, token))
        for (wrong in listOf(
            "https://127.0.0.1:54321/native-share/$file", "http://localhost:54321/native-share/$file",
            "http://127.0.0.1:54322/native-share/$file", "http://user@127.0.0.1:54321/native-share/$file",
            "$url?uri=$sourceUri", "$url#fragment", "$url/extra", "$origin/native-share/../pending",
            "$origin/native-share/%2e%2e", "$origin/native-share/%2f$file", "$origin/elsewhere/$file",
            "$origin/native-share/$sourceUri", "file:///$file",
        )) assertNull(wrong, NativeShareStore.requestedFile(wrong, origin, share, share))
    }

    @Test
    fun activeStreamsStopAfterAcknowledgementOrRunRevocation() {
        var allowed = true
        val input = NativeShareStore.guarded("data".byteInputStream()) { allowed }
        assertEquals('d'.code, input.read())
        allowed = false
        assertThrows(IOException::class.java) { input.read(ByteArray(4)) }
    }

    @Test
    fun revocationInsideAReadCannotReturnTheReadBytes() {
        var allowed = true
        val input = object : ByteArrayInputStream("data".toByteArray()) {
            override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
                val count = super.read(buffer, offset, length); allowed = false; return count
            }
        }
        assertThrows(IOException::class.java) { NativeShareStore.guarded(input) { allowed }.read(ByteArray(4)) }
    }

    @Test
    fun cameraIsOfferedForGenericOrCompatibleImageAccepts() {
        assertTrue(NativeShareStore.acceptsCamera(emptyList()))
        for (accept in listOf("", "*/*", " , ", "application/pdf, */*", "image/*", "image/jpeg", ".jpg", ".jpeg", "application/pdf, image/*")) {
            assertTrue(NativeShareStore.acceptsCamera(listOf(accept)))
        }
        for (accept in listOf("application/pdf", "image/png", "application/pdf, image/png")) assertFalse(NativeShareStore.acceptsCamera(listOf(accept)))
        assertFalse(NativeShareStore.acceptsCamera(listOf("", "application/pdf")))
    }
}
