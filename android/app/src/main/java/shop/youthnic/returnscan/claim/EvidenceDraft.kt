package shop.youthnic.returnscan.claim

import org.json.JSONArray
import org.json.JSONObject
import shop.youthnic.returnscan.util.replaceFileSafely
import java.io.File

/** One evidence file captured on the claim screen and not yet handed to an upload job. */
data class DraftFile(val path: String, val mimeType: String, val fieldKey: String)

/**
 * The claim screen's captured evidence, saved on every change so it survives the app being killed: by Android while
 * the camera app is open, or force-stopped. [returnKey] is the return it was captured for (ClaimPayload.returnKey), so
 * the screen keeps it only for that return. [pendingPhotoPath] is the file the camera app was asked to write
 * and [pendingFieldKey] the slot the camera, recorder or picker is filling.
 */
data class EvidenceDraft(
    val returnKey: String,
    val files: List<DraftFile>,
    val pendingPhotoPath: String = "",
    val pendingFieldKey: String = ""
) {
    /** Nothing to restore: no files, no photo being taken and no slot being filled. */
    val isEmpty: Boolean get() = files.isEmpty() && pendingPhotoPath.isBlank() && pendingFieldKey.isBlank()

    /** The saved files still on disk with content, in capture order: what the screen puts back. */
    fun restorableFiles(): List<DraftFile> = files.filter { hasContent(File(it.path)) }

    /** The camera photo, when the camera app wrote it but its result never reached the screen; otherwise null. */
    fun takenPendingPhoto(): File? = pendingPhotoPath.takeIf { it.isNotBlank() && pendingFieldKey.isNotBlank() }
        ?.let { File(it) }?.takeIf { hasContent(it) }

    /** Names of every file this draft still needs; the start-up clean-up never deletes them. */
    fun fileNames(): Set<String> =
        (files.map { it.path } + pendingPhotoPath).filter { it.isNotBlank() }.map { File(it).name }.toSet()

    fun toJson(): String = JSONObject().apply {
        put("returnKey", returnKey)
        put("pendingPhotoPath", pendingPhotoPath)
        put("pendingFieldKey", pendingFieldKey)
        put("files", JSONArray().apply {
            for (f in files) put(JSONObject().put("path", f.path).put("mimeType", f.mimeType).put("fieldKey", f.fieldKey))
        })
    }.toString()

    companion object {
        private fun hasContent(file: File): Boolean = file.isFile && file.length() > 0

        /** The draft in [text], or null when it is not a saved draft. */
        fun fromJson(text: String): EvidenceDraft? = try {
            val json = JSONObject(text)
            val array = json.optJSONArray("files") ?: JSONArray()
            val files = (0 until array.length()).mapNotNull { i ->
                val f = array.optJSONObject(i) ?: return@mapNotNull null
                DraftFile(f.optString("path"), f.optString("mimeType"), f.optString("fieldKey"))
                    .takeIf { it.path.isNotBlank() && it.mimeType.isNotBlank() && it.fieldKey.isNotBlank() }
            }
            EvidenceDraft(
                returnKey = json.optString("returnKey"),
                files = files,
                pendingPhotoPath = json.optString("pendingPhotoPath"),
                pendingFieldKey = json.optString("pendingFieldKey")
            )
        } catch (_: Exception) {
            null
        }
    }
}

/** Keeps one [EvidenceDraft] in [file]. Plain java.io and org.json, so JVM tests cover it. */
class EvidenceDraftStore(private val file: File) {

    /** Writes [draft] through a temporary file, so a kill mid-write keeps the previous draft. An empty draft removes the file. */
    fun save(draft: EvidenceDraft) {
        if (draft.isEmpty) {
            clear()
        } else {
            replaceFileSafely(file) { stream -> stream.write(draft.toJson().toByteArray(Charsets.UTF_8)); true }
        }
    }

    /** The saved draft, or null when there is none or it cannot be read. */
    fun load(): EvidenceDraft? = try {
        if (file.isFile) EvidenceDraft.fromJson(file.readText(Charsets.UTF_8)) else null
    } catch (_: Exception) {
        null
    }

    fun exists(): Boolean = file.exists()

    fun clear() {
        file.delete()
    }
}
