package dev.jupiter.mobile

import java.util.concurrent.atomic.AtomicBoolean

/** A revoked page or operation must never regain authority, even for the same run. */
internal class RunAuthorization(val runId: String) {
    private val revoked = AtomicBoolean(false)

    fun revoke() { revoked.set(true) }

    fun permits(loadedRun: String?, phase: String?, currentRun: String?): Boolean =
        !revoked.get() && runId.isNotBlank() && loadedRun == runId && phase == "ready" && currentRun == runId
}
