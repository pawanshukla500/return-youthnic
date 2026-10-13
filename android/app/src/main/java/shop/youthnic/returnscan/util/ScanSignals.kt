package shop.youthnic.returnscan.util

import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * Scan signals table:
 *   OK         1 short high beep     1 green blink     Return successfully saved to PostgreSQL
 *   DUPLICATE  3 quick high beeps    3 blue blinks     AWB already scanned previously
 *   NOT_FOUND  beep-boop (high-low)  2 purple blinks   AWB not found in active lookup
 *   CHECK      2 medium beeps        2 amber blinks    Verification / issue attention required
 *   STOP       low buzzer            3 red blinks      Save failed / blocking error
 */
enum class Cue { OK, DUPLICATE, NOT_FOUND, CHECK, STOP }

enum class Wave { SQUARE, TRIANGLE, SAWTOOTH }

data class Tone(val freqHz: Double, val startMs: Int, val durMs: Int, val wave: Wave, val gain: Double)

/** One screen blink: fully on for [onMs], then fading out and dark for [offMs]. */
data class Blink(val onMs: Int, val offMs: Int)

object ScanSignals {

    /** Overlay opacity at peak of blink: camera and verification card stay readable underneath. */
    const val FLASH_MAX_ALPHA = 0.62f

    private const val FADE_MS = 110
    private const val ATTACK_MS = 6.0
    private const val RELEASE_MS = 18.0

    // Photo-safe blink timings (never exceeding 3 flashes per second)
    fun blinks(cue: Cue): List<Blink> = when (cue) {
        Cue.OK -> listOf(Blink(170, 200))
        Cue.DUPLICATE -> List(3) { Blink(120, 220) }
        Cue.NOT_FOUND -> listOf(Blink(220, 200), Blink(300, 200))
        Cue.CHECK -> List(2) { Blink(150, 220) }
        Cue.STOP -> List(3) { Blink(260, 180) }
    }

    fun flashDurationMs(cue: Cue): Int = blinks(cue).sumOf { it.onMs + it.offMs }

    fun flashLevel(cue: Cue, tMs: Int): Float {
        if (tMs < 0) return 0f
        var start = 0
        for (b in blinks(cue)) {
            val t = tMs - start
            if (t < b.onMs) return 1f
            val fade = minOf(FADE_MS, b.offMs)
            if (t < b.onMs + fade) return 1f - (t - b.onMs).toFloat() / fade
            start += b.onMs + b.offMs
            if (tMs < start) return 0f
        }
        return 0f
    }

    /** Vibration pattern (delay, vibe, pause, vibe, ... in ms) */
    fun vibration(cue: Cue): LongArray = when (cue) {
        Cue.OK -> longArrayOf(0, 70)
        Cue.DUPLICATE -> longArrayOf(0, 70, 80, 70, 80, 70)
        Cue.NOT_FOUND -> longArrayOf(0, 180, 90, 320)
        Cue.CHECK -> longArrayOf(0, 120, 100, 120)
        Cue.STOP -> longArrayOf(0, 250, 100, 250, 100, 450)
    }

    /** Synthesized tones: identical frequencies and waveform character */
    fun tones(cue: Cue): List<Tone> = when (cue) {
        Cue.OK -> listOf(Tone(1568.0, 0, 90, Wave.SQUARE, 0.42))
        Cue.DUPLICATE -> List(3) { Tone(1319.0, it * 130, 70, Wave.SQUARE, 0.48) }
        Cue.NOT_FOUND -> listOf(Tone(988.0, 0, 200, Wave.TRIANGLE, 0.9), Tone(494.0, 240, 340, Wave.TRIANGLE, 0.9))
        Cue.CHECK -> listOf(Tone(880.0, 0, 130, Wave.SQUARE, 0.48), Tone(880.0, 200, 130, Wave.SQUARE, 0.48))
        Cue.STOP -> listOf(
            Tone(196.0, 0, 320, Wave.SAWTOOTH, 0.75),
            Tone(196.0, 420, 320, Wave.SAWTOOTH, 0.75),
            Tone(147.0, 840, 500, Wave.SAWTOOTH, 0.75)
        )
    }

    /** 16-bit mono PCM at [sampleRate] */
    fun pcm(cue: Cue, sampleRate: Int): ShortArray {
        val tones = tones(cue)
        val endMs = tones.maxOf { it.startMs + it.durMs } + 20
        val mix = DoubleArray((endMs * sampleRate / 1000.0).roundToInt())
        for (tone in tones) {
            val first = (tone.startMs * sampleRate / 1000.0).roundToInt()
            val count = (tone.durMs * sampleRate / 1000.0).roundToInt()
            for (i in 0 until count) {
                val idx = first + i
                if (idx >= mix.size) break
                val tMs = i * 1000.0 / sampleRate
                val envelope = minOf(1.0, tMs / ATTACK_MS, (tone.durMs - tMs) / RELEASE_MS).coerceAtLeast(0.0)
                val phase = (i.toDouble() * tone.freqHz / sampleRate) % 1.0
                mix[idx] += wave(tone.wave, phase) * tone.gain * envelope
            }
        }
        return ShortArray(mix.size) { (mix[it].coerceIn(-1.0, 1.0) * Short.MAX_VALUE).roundToInt().toShort() }
    }

    private fun wave(wave: Wave, phase: Double): Double = when (wave) {
        Wave.SQUARE -> if (phase < 0.5) 1.0 else -1.0
        Wave.TRIANGLE -> 4.0 * abs(phase - 0.5) - 1.0
        Wave.SAWTOOTH -> 2.0 * phase - 1.0
    }
}
