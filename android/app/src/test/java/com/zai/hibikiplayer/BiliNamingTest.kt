package com.zai.hibikiplayer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 命名规则单元测试（纯 JVM，不需要设备/模拟器，跑 :app:testDebugUnitTest）：
 *   · 单 P 视频   → 视频名.m4a（直接放在下载文件夹里）
 *   · 合集 / 多 P → 下载文件夹/<视频名>/<分P名>.m4a
 */
class BiliNamingTest {

    @Test
    fun singlePartUsesVideoTitleAndNoFolder() {
        assertEquals("", BiliNaming.folderName("校长来啦", false))
        assertEquals("校长来啦.m4a", BiliNaming.fileName("校长来啦", "校长来啦", 1, false, "mp4"))
        // 单 P 视频的 part 就是视频名，不能拼成「校长来啦 - 校长来啦」
        assertEquals("校长来啦.m4a", BiliNaming.fileName("校长来啦", "P1", 1, false, "mp4"))
    }

    @Test
    fun collectionUsesVideoFolderAndPartNames() {
        assertEquals("合集：某某挑战", BiliNaming.folderName("合集：某某挑战", true))
        assertEquals("P1 开场.m4a", BiliNaming.fileName("合集：某某挑战", "P1 开场", 1, true, "mp4"))
        assertEquals("第 12 期 · 中文标题.m4a", BiliNaming.fileName("合集：某某挑战", "第 12 期 · 中文标题", 12, true, "mp4"))
        // 子文件夹里的文件名不应再带视频名
        assertFalse(BiliNaming.fileName("合集：某某挑战", "P2 正片", 2, true, "mp4").contains("某某挑战"))
    }

    @Test
    fun collectionFallsBackToPageNumberWhenPartNameIsBlank() {
        assertEquals("P7.m4a", BiliNaming.fileName("合集", "", 7, true, "mp4"))
        assertEquals("P1.m4a", BiliNaming.fileName("合集", "   ", 0, true, "mp4"))
    }

    @Test
    fun illegalCharactersAreReplaced() {
        assertEquals("a_b_c_d_e_f_g_h_i", BiliNaming.safe("a/b\\c:d*e?f\"g<h>i"))
        // 「/」被替换成「_」后仍保留原有的空格（"P1: 半场 / 集锦" → "P1_ 半场 _ 集锦"）
        assertEquals("P1_ 半场 _ 集锦.m4a", BiliNaming.fileName("视频", "P1: 半场 / 集锦", 1, true, "mp4"))
        assertEquals("合集_ 上 _ 下", BiliNaming.folderName("合集: 上 / 下", true))
    }

    @Test
    fun longNamesAreTruncatedButKeepExtension() {
        val long = "长".repeat(200)
        val name = BiliNaming.fileName(long, "part", 1, false, "mp4")
        assertTrue(name.endsWith(".m4a"))
        assertTrue(name.length <= 86)
    }

    @Test
    fun containerAndFileExtensionsFollowTheCodec() {
        assertEquals("mp4", BiliNaming.extFor("ec-3"))          // 杜比 → MP4 容器（才能内嵌 covr 封面）
        assertEquals("m4a", BiliNaming.displayExtFor("mp4"))
        assertEquals("flac", BiliNaming.extFor("fLaC"))
        assertEquals("m4a", BiliNaming.extFor("mp4a.40.2"))
        assertEquals("杜比曲目.m4a", BiliNaming.fileName("杜比曲目", "杜比曲目", 1, false, BiliNaming.extFor("ec-3")))
        assertEquals("Hi-Res 曲目.flac", BiliNaming.fileName("Hi-Res 曲目", "Hi-Res 曲目", 1, false, BiliNaming.extFor("flac")))
    }

    @Test
    fun mimeMatchesExtensionSoMediaStoreDoesNotAppendAnotherOne() {
        assertEquals("audio/mp4", BiliNaming.mimeFor("曲目.m4a"))
        assertEquals("audio/flac", BiliNaming.mimeFor("曲目.flac"))
        assertEquals("audio/eac3", BiliNaming.mimeFor("曲目.eac3"))
        assertTrue(BiliNaming.isRawStream("eac3"))
        assertFalse(BiliNaming.isRawStream("mp4"))
        assertFalse(BiliNaming.isRawStream("m4a"))
    }

    @Test
    fun collectionMetadataUsesPartTitleAndVideoAlbum() {
        // 播放器里显示的标题 = 分P名（与文件名一致）
        assertEquals("P3 正片", BiliNaming.metaTitle("合集：某某挑战", "P3 正片", 3, true))
        assertEquals("P3", BiliNaming.metaTitle("合集：某某挑战", "", 3, true))
        // 标签不做文件系统过滤：冒号、斜杠等原样保留
        assertEquals("第 5 期：上/下", BiliNaming.metaTitle("合集", "第 5 期：上/下", 5, true))
        // 专辑用视频名，方便播放器把同一合集归到一张专辑
        assertEquals("合集：某某挑战", BiliNaming.metaAlbum("合集：某某挑战", true))
    }

    @Test
    fun singlePartMetadataKeepsFullTitle() {
        assertEquals("校长来啦", BiliNaming.metaTitle("校长来啦", "校长来啦", 1, false))
        assertEquals("校长来啦", BiliNaming.metaTitle("校长来啦", "P1", 1, false))
        assertEquals("视频 - 花絮", BiliNaming.metaTitle("视频", "花絮", 2, false))
        assertEquals("Bilibili", BiliNaming.metaAlbum("校长来啦", false))
    }

    @Test
    fun emptyTitleNeverProducesAnEmptyName() {
        assertEquals("bilibili_audio.m4a", BiliNaming.fileName("", "", 0, false, "mp4"))
        assertEquals("P1.m4a", BiliNaming.fileName("", "", 0, true, "mp4"))
    }
}
