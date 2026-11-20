package shop.youthnic.returnscan.util

/**
 * Numbers work per key so only the newest piece for a key is used. The claim screen runs return lookups and photo
 * shrinking off the main thread, and one started earlier can finish later: its result must never replace a newer one.
 * Pure Kotlin, so JVM tests cover it. Not thread-safe: the claim screen calls it on the main thread only.
 */
class NewestWins {
    private var last = 0L
    private val newest = HashMap<String, Long>()

    /** Starts new work for [key], which makes all earlier work for it stale. Returns the new work's ticket. */
    fun next(key: String): Long {
        last++
        newest[key] = last
        return last
    }

    /** True while no later work for [key] has started since [ticket] was handed out. */
    fun isNewest(key: String, ticket: Long): Boolean = newest[key] == ticket
}
