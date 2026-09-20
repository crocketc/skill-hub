#!/usr/bin/env python3
"""OPT-20260914-06 / D5-11：从既有母版加工 macOS Dock 图标母版与图标资源。

背景：macOS 真机反馈 Dock 图标四角直角、视觉尺寸偏大。本脚本把旧的
1254×1254 RGB 全出血方图母版加工为 1024×1024 RGBA 母版（圆角外层 +
透明边距），并从中重新生成 macOS `.icns` 与 Tauri 引用的 PNG 家族。
不重绘品牌图形，只做等比缩放 + 圆角 alpha 蒙版 + 居中合成。

几何参数（与 apps/desktop/src/app/tauriIconAssets.test.ts 的断言一致）：
- CANVAS  = 1024 px   母版画布边长。
- OUTER   = 896 px    圆角外层边长 = 画布的 87.5%（目标 86%—88%）。
- MARGIN  = 64 px     四周透明边距 = 画布的 6.25%（目标 6%—7%）。
- RADIUS  = 180 px    圆角半径 = 外层边长的 20.1%（macOS 惯例 18%—22.5%）。
- SS      = 4         蒙版超采样倍率，用于平滑的抗锯齿 alpha 边缘。

品牌主标记占比：旧母版实测标记包围盒 615×754（宽 49.0% / 高 60.1%）。
等比缩放下标记与外层的比值固定（0.601），外层取 86%—88% 时标记只能落
在约 51%—53%；按任务裁决以外层 + 边距为硬约束，标记实际占比如实记录
（脚本自检会输出实测值）。

用法（仓库根目录）：
    python3 assets/branding/generate-macos-icon.py [--source PATH]
    python3 assets/branding/generate-macos-icon.py --candidate [--outer N] [--margin N] [--radius N]

`--candidate` 仅从**现有** 1024×1024 RGBA 母版“重切边距”生成候选母版与候选
`.icns`（写到 `skillhub-app-icon-master-candidate.png` / `.icns`），绝不覆盖既有
母版 / `icon.icns` / `icon.ico`，也不写入 `tauri-icons` / `src-tauri/icons`，从而
保留回滚基线。详见脚本下方“候选几何”常量与 D5-11 / OPT-20260914-06 整改说明。

`--source` 默认指向母版路径本身；仅当母版仍是旧的 1254 全出血 RGB 方图
时可直接运行。母版被替换后如需再加工，请先从 git 历史取出旧母版：
    git show <旧提交>:assets/branding/skillhub-app-icon-master.png > /tmp/old-master.png
    python3 assets/branding/generate-macos-icon.py --source /tmp/old-master.png

只覆盖：母版、`assets/branding/tauri-icons/` 与
`apps/desktop/src-tauri/icons/` 两处的 icon.icns / icon.png(512) /
32x32 / 64x64 / 128x128 / 128x128@2x。绝不触碰 icon.ico（Windows 图标
已真机验收通过，必须逐字节不变）、Square*/StoreLogo 及 android/、ios/。
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

# --- 几何参数 ---------------------------------------------------------------
CANVAS = 1024
OUTER = 896
MARGIN = (CANVAS - OUTER) // 2  # 64
RADIUS = 180
SS = 4

# --- 候选几何（D5-11 macOS Dock 视觉偏大整改，OPT-20260914-06）-------------
# 现状母版外层 896（87.5%）/ 边距 64（6.25%）在 Dock 中与相邻 App 并排时仍显
# 得略大（人工验收边界，非回归）。候选“仅切掉更多暗色背景、不重绘品牌图形”：
# 外层 864（84.4%）、边距 80（7.8%），品牌主标记随外层等比缩小。圆角半径按
# 外层 20.1% 取 174，保持既有的圆角观感。仅生成候选文件，保留回滚基线。
CAND_OUTER = 864
CAND_MARGIN = (CANVAS - CAND_OUTER) // 2  # 80
CAND_RADIUS = 174

# 旧母版中品牌主标记的亮度阈值（仅用于自检报告，不参与加工）。
MARK_BRIGHTNESS_THRESHOLD = 150

# 需要覆盖的 PNG 家族：<目标文件名> -> <边长>
PNG_FAMILY = {
    "icon.png": 512,
    "32x32.png": 32,
    "64x64.png": 64,
    "128x128.png": 128,
    "128x128@2x.png": 256,
}

# macOS iconset 标准命名：<文件名> -> <边长>
ICONSET_FILES = {
    "icon_16x16.png": 16,
    "icon_16x16@2x.png": 32,
    "icon_32x32.png": 32,
    "icon_32x32@2x.png": 64,
    "icon_128x128.png": 128,
    "icon_128x128@2x.png": 256,
    "icon_256x256.png": 256,
    "icon_256x256@2x.png": 512,
    "icon_512x512.png": 512,
    "icon_512x512@2x.png": 1024,
}

COPY_TARGETS = [
    "icon.icns",
    *PNG_FAMILY.keys(),
]


def build_master(source: Image.Image) -> Image.Image:
    """等比缩放 + 圆角蒙版 + 居中合成，返回 1024×1024 RGBA 母版。"""
    if source.mode != "RGB":
        raise SystemExit(f"source must be RGB full-bleed artwork, got mode={source.mode}")
    if source.width != source.height:
        raise SystemExit(f"source must be square, got {source.width}x{source.height}")

    tile = source.resize((OUTER, OUTER), Image.Resampling.LANCZOS).convert("RGBA")

    # 超采样圆角蒙版：SS 倍绘制再 LANCZOS 缩回，得到平滑 alpha 边缘。
    mask = Image.new("L", (OUTER * SS, OUTER * SS), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, OUTER * SS - 1, OUTER * SS - 1),
        radius=RADIUS * SS,
        fill=255,
    )
    mask = mask.resize((OUTER, OUTER), Image.Resampling.LANCZOS)
    tile.putalpha(mask)

    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    canvas.alpha_composite(tile, (MARGIN, MARGIN))
    return canvas


def build_candidate(master: Image.Image, outer: int, margin: int, radius: int) -> Image.Image:
    """从既有 1024×1024 RGBA 母版“重切边距”得到候选母版。

    裁剪母版的不透明块（暗色圆角外层 + 品牌主标记）、等比缩到 `outer`、重新套
    圆角 alpha 蒙版、居中合成到 1024 透明画布。品牌图形随外层等比缩放、**不重
    绘**；仅放大透明边距以缓解 Dock 中视觉偏大。绝不读写 Windows `.ico` 或受控
    副本目录。
    """
    if master.mode != "RGBA" or master.size != (CANVAS, CANVAS):
        raise SystemExit(f"candidate mode needs the existing {CANVAS}x{CANVAS} RGBA master, got {master.mode} {master.size}")
    alpha = master.getchannel("A")
    bbox = alpha.point(lambda v: 255 if v >= 128 else 0).getbbox()
    if bbox is None:
        raise SystemExit("candidate mode: master has no opaque pixels to re-margin")
    tile = master.crop(bbox).resize((outer, outer), Image.Resampling.LANCZOS).convert("RGBA")

    mask = Image.new("L", (outer * SS, outer * SS), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, outer * SS - 1, outer * SS - 1),
        radius=radius * SS,
        fill=255,
    )
    mask = mask.resize((outer, outer), Image.Resampling.LANCZOS)
    tile.putalpha(mask)

    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    canvas.alpha_composite(tile, (margin, margin))
    return canvas


def run_sips(size: int, source: Path, destination: Path) -> None:
    subprocess.run(
        ["sips", "-s", "format", "png", "-z", str(size), str(size), str(source), "--out", str(destination)],
        check=True,
        capture_output=True,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    repo_root = Path(__file__).resolve().parents[2]
    default_master = repo_root / "assets" / "branding" / "skillhub-app-icon-master.png"
    parser.add_argument(
        "--source",
        type=Path,
        default=default_master,
        help="旧的全出血 RGB 方图母版路径（默认为母版路径本身）",
    )
    parser.add_argument(
        "--candidate",
        action="store_true",
        help="从现有 1024×1024 RGBA 母版重切边距，仅生成候选母版 + 候选 .icns（不动既有母版/.icns/.ico）",
    )
    parser.add_argument("--outer", type=int, default=None, help="候选外层边长（默认 %d）" % CAND_OUTER)
    parser.add_argument("--margin", type=int, default=None, help="候选四周透明边距（默认由 (画布-outer)/2 推导）")
    parser.add_argument("--radius", type=int, default=None, help="候选圆角半径（默认 %d）" % CAND_RADIUS)
    args = parser.parse_args()
    source_path: Path = args.source

    if args.candidate:
        outer = args.outer or CAND_OUTER
        radius = args.radius or CAND_RADIUS
        margin = args.margin if args.margin is not None else (CANVAS - outer) // 2
        if margin < 0 or outer <= 0 or outer + 2 * margin > CANVAS:
            raise SystemExit(f"candidate geometry invalid: outer={outer} margin={margin} (canvas={CANVAS})")

        master = Image.open(default_master).convert("RGBA")
        candidate = build_candidate(master, outer, margin, radius)
        cand_png = default_master.parent / f"{default_master.stem}-candidate{default_master.suffix}"
        candidate.save(cand_png)
        print(f"[candidate master] wrote {cand_png} ({CANVAS}x{CANVAS} RGBA, outer={outer}, margin={margin}, radius={radius})")

        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            iconset = tmp_dir / "icon.iconset"
            iconset.mkdir()
            for name, size in ICONSET_FILES.items():
                run_sips(size, cand_png, iconset / name)
            icns_built = tmp_dir / "icon.icns"
            subprocess.run(
                ["iconutil", "-c", "icns", str(iconset), "-o", str(icns_built)],
                check=True,
                capture_output=True,
            )
            cand_icns = default_master.parent / f"{default_master.stem}-candidate.icns"
            data = icns_built.read_bytes()
            cand_icns.write_bytes(data)
            print(f"[candidate icns] wrote {cand_icns} ({len(data)} bytes)")

        self_check(cand_png, master.convert("RGB"))
        return

    source = Image.open(source_path)
    source.load()  # 母版路径即输出路径：先完整读入源数据再覆盖。
    if source.mode == "RGBA" and source.size == (CANVAS, CANVAS):
        raise SystemExit(
            "refusing to double-process: the master already carries the OPT-06 "
            "geometry. Pass --source pointing at the pre-OPT-06 1254x1254 RGB "
            "artwork (see module docstring for the git show recipe)."
        )
    source_rgb = source.convert("RGB")

    master = build_master(source_rgb)
    master_path = default_master
    master.save(master_path)
    print(f"[master] wrote {master_path} ({CANVAS}x{CANVAS} RGBA)")

    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        iconset = tmp_dir / "icon.iconset"
        iconset.mkdir()
        for name, size in ICONSET_FILES.items():
            run_sips(size, master_path, iconset / name)
        icns_built = tmp_dir / "icon.icns"
        subprocess.run(
            ["iconutil", "-c", "icns", str(iconset), "-o", str(icns_built)],
            check=True,
            capture_output=True,
        )
        family_built = {"icon.icns": icns_built}
        for name, size in PNG_FAMILY.items():
            built = tmp_dir / name
            run_sips(size, master_path, built)
            family_built[name] = built

        brand_icons = repo_root / "assets" / "branding" / "tauri-icons"
        app_icons = repo_root / "apps" / "desktop" / "src-tauri" / "icons"
        for name in COPY_TARGETS:
            data = family_built[name].read_bytes()
            for target_dir in (brand_icons, app_icons):
                (target_dir / name).write_bytes(data)
            a = (brand_icons / name).read_bytes()
            b = (app_icons / name).read_bytes()
            if a != b:
                raise SystemExit(f"controlled copies diverge for {name}")
            print(f"[copy] {name}: {len(a)} bytes synced to tauri-icons + src-tauri/icons")

    self_check(master_path, source_rgb)


def self_check(master_path: Path, source_rgb: Image.Image) -> None:
    """几何自检：外层占比、边距、四角 alpha、主标记占比（如实输出）。"""
    master = Image.open(master_path).convert("RGBA")
    alpha = master.getchannel("A")
    bbox = alpha.point(lambda v: 255 if v >= 128 else 0).getbbox()
    left, top, right, bottom = bbox
    side = max(right - left, bottom - top)
    margins = {
        "left": left,
        "top": top,
        "right": CANVAS - right,
        "bottom": CANVAS - bottom,
    }
    print("[check] outer opaque bbox:", bbox)
    print(f"[check] outer side fraction: {side / CANVAS:.4f} (target 0.86-0.88)")
    for edge, value in margins.items():
        print(f"[check] {edge} margin: {value}px = {value / CANVAS:.4f} (target 0.06-0.07)")

    corners = [(0, 0), (CANVAS - 1, 0), (0, CANVAS - 1), (CANVAS - 1, CANVAS - 1)]
    print("[check] corner alphas:", [master.getpixel(pt)[3] for pt in corners])

    # 主标记占比：与旧母版同口径（R+G+B 通道和 >= 阈值），按新画布丈量。
    # ImageChops.add 逐通道相加（上限截断 255）；阈值 150 以下不会截断，
    # 因此与“通道和 > 阈值”的口径完全一致。
    def mark_bbox_of(image: Image.Image):
        r, g, b = image.convert("RGB").split()
        total = ImageChops.add(ImageChops.add(r, g), b)
        mask = total.point(lambda v: 255 if v >= MARK_BRIGHTNESS_THRESHOLD else 0)
        return mask.getbbox()

    mark_bbox = mark_bbox_of(master)
    if mark_bbox:
        mw = mark_bbox[2] - mark_bbox[0]
        mh = mark_bbox[3] - mark_bbox[1]
        print(f"[check] brand mark bbox: {mark_bbox} ({mw}x{mh}px, width {mw / CANVAS:.4f}, height {mh / CANVAS:.4f})")

    # 旧母版同口径对照（宽/高占旧画布比例）。
    old_mark_bbox = mark_bbox_of(source_rgb)
    if old_mark_bbox:
        ow = old_mark_bbox[2] - old_mark_bbox[0]
        oh = old_mark_bbox[3] - old_mark_bbox[1]
        print(
            f"[check] old-canvas mark bbox: {old_mark_bbox} "
            f"(width {ow / source_rgb.width:.4f}, height {oh / source_rgb.height:.4f})"
        )


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        sys.exit(f"external tool failed: {error}")
