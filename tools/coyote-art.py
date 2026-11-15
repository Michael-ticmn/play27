# Coyote art generator. Writes the SVGs in assets/coyote/.
# Usage (from the repo root): py tools/coyote-art.py .
# Edit shapes here and rerun rather than hand-editing the SVG files.
"""Generates Coyote art (SVG) into <repo>/assets/coyote/.
Flat, geometric, play27 house style (see assets/card-back.svg)."""
import pathlib, sys

OUT = pathlib.Path(sys.argv[1]) / "assets" / "coyote"
OUT.mkdir(parents=True, exist_ok=True)

INK = "#15171a"
WHITE = "#f3efe6"


def portrait(bg, ring, art, title):
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="120" height="120" role="img" aria-label="{title}">
  <title>{title}</title>
  <defs><clipPath id="c"><circle cx="60" cy="60" r="56"/></clipPath></defs>
  <circle cx="60" cy="60" r="58" fill="{bg}"/>
  <g clip-path="url(#c)">
{art}
  </g>
  <circle cx="60" cy="60" r="57" fill="none" stroke="{ring}" stroke-width="2.5"/>
</svg>
"""


def eye(cx, cy, r=3.6, glint=True):
    s = f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="{INK}"/>'
    if glint:
        s += f'<circle cx="{cx + r * 0.3:.1f}" cy="{cy - r * 0.35:.1f}" r="{r * 0.32:.1f}" fill="#fff"/>'
    return s


CHARS = {}

# ── Old Blue: bluetick hound ──
CHARS["oldblue"] = ("#1d2833", "Old Blue the hound", f"""
    <path d="M18 120 C22 98 40 90 60 90 C80 90 98 98 102 120 Z" fill="#5d6f82"/>
    <path d="M42 32 C26 38 18 62 22 86 C24 98 36 100 41 90 C45 76 47 54 50 40 Z" fill="#3d4a58"/>
    <path d="M78 32 C94 38 102 62 98 86 C96 98 84 100 79 90 C75 76 73 54 70 40 Z" fill="#3d4a58"/>
    <path d="M40 40 C30 48 26 66 28 84" stroke="#5d6f82" stroke-width="2" fill="none" stroke-linecap="round"/>
    <path d="M80 40 C90 48 94 66 92 84" stroke="#5d6f82" stroke-width="2" fill="none" stroke-linecap="round"/>
    <path d="M60 20 C77 20 85 33 85 50 C85 64 81 72 77 78 L43 78 C39 72 35 64 35 50 C35 33 43 20 60 20 Z" fill="#8a9bad"/>
    <g fill="#5d6f82"><circle cx="46" cy="32" r="2"/><circle cx="53" cy="27" r="1.6"/><circle cx="70" cy="30" r="2.2"/><circle cx="76" cy="38" r="1.6"/><circle cx="41" cy="40" r="1.5"/><circle cx="63" cy="26" r="1.4"/></g>
    <path d="M43 66 C43 58 51 56 60 56 C69 56 77 58 77 66 L77 80 C77 90 69 97 60 97 C51 97 43 90 43 80 Z" fill="#c9d1d9"/>
    <g fill="#8a9bad"><circle cx="49" cy="84" r="1.3"/><circle cx="71" cy="84" r="1.3"/><circle cx="53" cy="89" r="1.1"/><circle cx="67" cy="89" r="1.1"/></g>
    <ellipse cx="49" cy="44" rx="4.2" ry="2.6" fill="#c8955a"/>
    <ellipse cx="71" cy="44" rx="4.2" ry="2.6" fill="#c8955a"/>
    {eye(49, 51)}{eye(71, 51)}
    <path d="M51 64 C51 59 69 59 69 64 C69 69 64 72 60 72 C56 72 51 69 51 64 Z" fill="{INK}"/>
    <path d="M60 72 L60 79 M60 79 C56 83 51 82 48 79 M60 79 C64 83 69 82 72 79" stroke="{INK}" stroke-width="2" fill="none" stroke-linecap="round"/>
    <path d="M34 104 C46 96 74 96 86 104 L85 111 C73 103 47 103 35 111 Z" fill="#a8452f"/>
    <circle cx="60" cy="108" r="4.6" fill="#d4a027"/><circle cx="60" cy="108" r="1.6" fill="#a87d1c"/>
""")

# ── Mabel: goose in profile, teal bow ──
CHARS["mabel"] = ("#1c2c2d", "Mabel the goose", f"""
    <ellipse cx="44" cy="114" rx="42" ry="22" fill="#e2ddd1"/>
    <path d="M40 104 C40 84 43 68 49 57 C53 49 57 43 60 37" stroke="{WHITE}" stroke-width="21" fill="none" stroke-linecap="round"/>
    <ellipse cx="64" cy="36" rx="16.5" ry="13.5" fill="{WHITE}"/>
    <path d="M76 31 C87 31 97 35 102 40 C97 45 87 47 76 45 Z" fill="#e8892b"/>
    <path d="M78 40 C87 40 95 40.6 101 40.6" stroke="#b9661c" stroke-width="1.6" fill="none" stroke-linecap="round"/>
    <ellipse cx="80" cy="35" rx="2" ry="1.2" fill="#b9661c"/>
    {eye(68, 32, 2.9)}
    <path d="M45 76 L34 69 L34 84 Z" fill="#3ea8aa"/>
    <path d="M47 76 L58 69 L58 84 Z" fill="#3ea8aa"/>
    <circle cx="46" cy="76" r="3.6" fill="#2e8a8c"/>
""")

# ── Woolly: ram with curled horns ──
CHARS["woolly"] = ("#2a2720", "Woolly the ram", f"""
    <g fill="#e9e1cf"><circle cx="18" cy="114" r="17"/><circle cx="39" cy="108" r="17"/><circle cx="60" cy="106" r="18"/><circle cx="81" cy="108" r="17"/><circle cx="102" cy="114" r="17"/></g>
    <path d="M47 40 C31 29 14 40 16 58 C18 73 33 77 39 67 C43 59 37 52 30 56" stroke="#a8844a" stroke-width="10" fill="none" stroke-linecap="round"/>
    <path d="M73 40 C89 29 106 40 104 58 C102 73 87 77 81 67 C77 59 83 52 90 56" stroke="#a8844a" stroke-width="10" fill="none" stroke-linecap="round"/>
    <path d="M47 40 C31 29 14 40 16 58" stroke="#c4a266" stroke-width="3" fill="none" stroke-linecap="round" stroke-dasharray="2 5"/>
    <path d="M73 40 C89 29 106 40 104 58" stroke="#c4a266" stroke-width="3" fill="none" stroke-linecap="round" stroke-dasharray="2 5"/>
    <ellipse cx="40" cy="54" rx="9" ry="4.2" fill="#cdbb98" transform="rotate(22 40 54)"/>
    <ellipse cx="80" cy="54" rx="9" ry="4.2" fill="#cdbb98" transform="rotate(-22 80 54)"/>
    <path d="M60 36 C72 36 76 46 76 58 C76 74 70 92 60 92 C50 92 44 74 44 58 C44 46 48 36 60 36 Z" fill="#d8c8a8"/>
    <g fill="#f1eadb"><circle cx="48" cy="35" r="10"/><circle cx="60" cy="29" r="11"/><circle cx="72" cy="35" r="10"/><circle cx="54" cy="41" r="8"/><circle cx="66" cy="41" r="8"/></g>
    <ellipse cx="52" cy="57" rx="4.4" ry="3.2" fill="#e9c46a"/><rect x="49" y="56.2" width="6" height="1.7" rx=".8" fill="{INK}"/>
    <ellipse cx="68" cy="57" rx="4.4" ry="3.2" fill="#e9c46a"/><rect x="65" y="56.2" width="6" height="1.7" rx=".8" fill="{INK}"/>
    <ellipse cx="56" cy="78" rx="2.2" ry="1.5" fill="#6d5a43"/><ellipse cx="64" cy="78" rx="2.2" ry="1.5" fill="#6d5a43"/>
    <path d="M60 81 L60 85 M54 85 C56 88 64 88 66 85" stroke="#6d5a43" stroke-width="2.2" fill="none" stroke-linecap="round"/>
""")

# ── Clementine: dairy cow with a clementine blossom ──
CHARS["clementine"] = ("#2a231e", "Clementine the dairy cow", f"""
    <path d="M18 120 C22 100 40 94 60 94 C80 94 98 100 102 120 Z" fill="{WHITE}"/>
    <path d="M71 96 C82 98 93 104 97 120 L73 120 C75 110 72 104 71 96 Z" fill="#26292e"/>
    <path d="M44 31 C39 22 41 15 48 13 C46 20 48 26 53 31 Z" fill="#e6dcc4"/>
    <path d="M76 31 C81 22 79 15 72 13 C74 20 72 26 67 31 Z" fill="#e6dcc4"/>
    <ellipse cx="29" cy="45" rx="14" ry="7.5" fill="{WHITE}" transform="rotate(-15 29 45)"/>
    <ellipse cx="30" cy="45" rx="8.5" ry="3.8" fill="#e9a3a3" transform="rotate(-15 30 45)"/>
    <ellipse cx="91" cy="45" rx="14" ry="7.5" fill="{WHITE}" transform="rotate(15 91 45)"/>
    <ellipse cx="90" cy="45" rx="8.5" ry="3.8" fill="#e9a3a3" transform="rotate(15 90 45)"/>
    <path d="M60 26 C76 26 82 36 82 50 C82 62 80 70 78 76 L42 76 C40 70 38 62 38 50 C38 36 44 26 60 26 Z" fill="{WHITE}"/>
    <path d="M64 27 C76 26 82 36 82 48 C80 57 71 59 65 52 C59 45 58 33 64 27 Z" fill="#26292e"/>
    <circle cx="50" cy="48" r="3.7" fill="{INK}"/><circle cx="51.2" cy="46.8" r="1.2" fill="#fff"/>
    <circle cx="70" cy="48" r="4.8" fill="{WHITE}"/>{eye(70, 48, 3.3)}
    <rect x="40" y="63" width="40" height="30" rx="15" fill="#eaa5a5"/>
    <ellipse cx="51" cy="77" rx="3.4" ry="4.6" fill="#9e5b5b"/><ellipse cx="69" cy="77" rx="3.4" ry="4.6" fill="#9e5b5b"/>
    <g transform="translate(47 30)">
      <g fill="#ef8f2f"><circle cx="0" cy="-5" r="3.4"/><circle cx="4.8" cy="-1.5" r="3.4"/><circle cx="3" cy="4" r="3.4"/><circle cx="-3" cy="4" r="3.4"/><circle cx="-4.8" cy="-1.5" r="3.4"/></g>
      <circle r="2.6" fill="#f6d36b"/>
    </g>
""")

# ── Tiny: big bull with a gold nose ring ──
CHARS["tiny"] = ("#2a1d1d", "Tiny the bull", f"""
    <path d="M8 120 C12 96 34 87 60 87 C86 87 108 96 112 120 Z" fill="#2c1f19"/>
    <path d="M38 41 C25 41 13 34 9 19 C17 28 28 30 40 30 Z" fill="#ece3cd"/>
    <path d="M82 41 C95 41 107 34 111 19 C103 28 92 30 80 30 Z" fill="#ece3cd"/>
    <ellipse cx="29" cy="50" rx="11" ry="6" fill="#4a332a" transform="rotate(-12 29 50)"/>
    <ellipse cx="91" cy="50" rx="11" ry="6" fill="#4a332a" transform="rotate(12 91 50)"/>
    <path d="M60 25 C79 25 87 36 87 50 C87 62 83 72 79 80 L41 80 C37 72 33 62 33 50 C33 36 41 25 60 25 Z" fill="#5a3d30"/>
    <path d="M48 30 C53 22 67 22 72 30 C67 27 63 32 60 27 C57 32 53 27 48 30 Z" fill="#3e2a22"/>
    <path d="M41 47 L55 51" stroke="#2c1f19" stroke-width="4" stroke-linecap="round"/>
    <path d="M79 47 L65 51" stroke="#2c1f19" stroke-width="4" stroke-linecap="round"/>
    {eye(49, 56, 3.3)}{eye(71, 56, 3.3)}
    <path d="M41 68 C41 61 50 59 60 59 C70 59 79 61 79 68 L79 83 C79 93 70 97 60 97 C50 97 41 93 41 83 Z" fill="#8a6a58"/>
    <ellipse cx="51" cy="76" rx="3.6" ry="4.8" fill="#2c1f19"/><ellipse cx="69" cy="76" rx="3.6" ry="4.8" fill="#2c1f19"/>
    <path d="M53 84 C53 95 67 95 67 84" stroke="#d4a027" stroke-width="3.4" fill="none" stroke-linecap="round"/>
""")

# ── Duke: proud rooster ──
CHARS["duke"] = ("#2a2517", "Duke the rooster", f"""
    <path d="M14 120 C18 98 38 90 60 90 C82 90 102 98 106 120 Z" fill="#6e2a20"/>
    <path d="M38 72 L30 106 L43 86 L44 112 L52 88 L56 114 L60 90 L64 114 L68 88 L76 112 L77 86 L90 106 L82 72 Z" fill="#e0a640"/>
    <path d="M44 80 L40 100 L48 88 L52 104 L56 90 L60 106 L64 90 L68 104 L72 88 L80 100 L76 80 Z" fill="#c98a2e"/>
    <ellipse cx="60" cy="55" rx="19.5" ry="23.5" fill="#f1e4c8"/>
    <g fill="#d64545"><circle cx="49" cy="33" r="7"/><circle cx="60" cy="27" r="8.5"/><circle cx="71" cy="33" r="7"/><rect x="47" y="31" width="26" height="9" rx="3"/></g>
    <path d="M55 69 C52 80 57 88 60 88 C63 88 68 80 65 69 Z" fill="#d64545"/>
    <path d="M52 60 L68 60 L60 73 Z" fill="#e8b23a"/>
    <path d="M54 63.5 L66 63.5" stroke="#b8862a" stroke-width="1.3"/>
    <circle cx="50" cy="51" r="4.6" fill="#e9a23b"/>{eye(50, 51, 2.5)}
    <circle cx="70" cy="51" r="4.6" fill="#e9a23b"/>{eye(70, 51, 2.5)}
""")

# ── Hazel: barn owl ──
CHARS["hazel"] = ("#23211c", "Hazel the barn owl", f"""
    <path d="M20 120 C22 96 40 86 60 86 C80 86 98 96 100 120 Z" fill="#c99a63"/>
    <g fill="#8a6a44"><circle cx="38" cy="104" r="1.6"/><circle cx="48" cy="98" r="1.4"/><circle cx="72" cy="98" r="1.4"/><circle cx="82" cy="104" r="1.6"/><circle cx="60" cy="110" r="1.4"/></g>
    <path d="M60 17 C83 17 95 34 95 54 C95 75 81 91 60 91 C39 91 25 75 25 54 C25 34 37 17 60 17 Z" fill="#cf9f66"/>
    <g fill="#8a6a44"><circle cx="46" cy="24" r="1.5"/><circle cx="60" cy="21" r="1.5"/><circle cx="74" cy="24" r="1.5"/><circle cx="33" cy="40" r="1.4"/><circle cx="87" cy="40" r="1.4"/></g>
    <path d="M60 35 C66 25 87 23 89 44 C91 63 75 81 60 89 C45 81 29 63 31 44 C33 23 54 25 60 35 Z" fill="#f5efe4" stroke="#b8824a" stroke-width="2.2"/>
    <ellipse cx="48.5" cy="54" rx="6" ry="7.2" fill="{INK}"/><circle cx="50.3" cy="51.6" r="1.8" fill="#fff"/>
    <ellipse cx="71.5" cy="54" rx="6" ry="7.2" fill="{INK}"/><circle cx="73.3" cy="51.6" r="1.8" fill="#fff"/>
    <path d="M57 63 C58 70 60 75 60 75 C60 75 62 70 63 63 C61 61 59 61 57 63 Z" fill="#d9b8a0"/>
""")

# ── Boots: tuxedo barn cat ──
CHARS["boots"] = ("#1d2a22", "Boots the barn cat", f"""
    <path d="M14 120 C18 98 39 88 60 88 C81 88 102 98 106 120 Z" fill="#4a4e57"/>
    <path d="M44 120 C46 104 52 94 60 94 C68 94 74 104 76 120 Z" fill="{WHITE}"/>
    <path d="M33 52 L29 16 L55 34 Z" fill="#4a4e57"/><path d="M36 45 L34 25 L49 36 Z" fill="#e9a3a3"/>
    <path d="M87 52 L91 16 L65 34 Z" fill="#4a4e57"/><path d="M84 45 L86 25 L71 36 Z" fill="#e9a3a3"/>
    <ellipse cx="60" cy="58" rx="29" ry="27" fill="#4a4e57"/>
    <path d="M60 45 C66 56 77 62 77 72 C77 80 69 85 60 85 C51 85 43 80 43 72 C43 62 54 56 60 45 Z" fill="{WHITE}"/>
    <ellipse cx="47" cy="56" rx="6.4" ry="5.2" fill="#7fd08f"/><ellipse cx="47" cy="56" rx="1.7" ry="4.6" fill="{INK}"/>
    <ellipse cx="73" cy="56" rx="6.4" ry="5.2" fill="#7fd08f"/><ellipse cx="73" cy="56" rx="1.7" ry="4.6" fill="{INK}"/>
    <path d="M56 66 L64 66 L60 71 Z" fill="#e48f9a"/>
    <path d="M60 71 C58 75 54 75 52 73 M60 71 C62 75 66 75 68 73" stroke="#7b7f88" stroke-width="1.7" fill="none" stroke-linecap="round"/>
    <g stroke="#c9ccd2" stroke-width="1.3" stroke-linecap="round"><line x1="42" y1="70" x2="17" y2="65"/><line x1="42" y1="74" x2="17" y2="77"/><line x1="78" y1="70" x2="103" y2="65"/><line x1="78" y1="74" x2="103" y2="77"/></g>
""")

# ── Roles ──
SHEEP = """<g transform="translate({x} {y}) scale({s})">
      <g stroke="#2b2f36" stroke-width="2.4" stroke-linecap="round"><line x1="-7" y1="8" x2="-7" y2="15"/><line x1="7" y1="8" x2="7" y2="15"/></g>
      <g fill="#f1eadb"><circle cx="-9" cy="0" r="7"/><circle cx="0" cy="-3" r="8"/><circle cx="9" cy="0" r="7"/><circle cx="-4" cy="5" r="6"/><circle cx="5" cy="5" r="6"/></g>
      <ellipse cx="{hx}" cy="-1" rx="5" ry="4.2" fill="#2b2f36"/>
    </g>"""

ROLES = {}
ROLES["shepherd"] = ("#2a2517", "#d4a027", "Shepherd", f"""
    <path d="M0 92 C30 82 52 88 72 84 C92 80 108 86 120 90 L120 120 L0 120 Z" fill="#24402f"/>
    <path d="M70 110 L70 42 C70 27 89 25 91 38 C92 47 84 50 80 44" stroke="#d4a027" stroke-width="6.5" fill="none" stroke-linecap="round"/>
    <ellipse cx="44" cy="56" rx="25" ry="6.5" fill="#d9b25a"/>
    <path d="M31 56 C31 40 57 40 57 56 Z" fill="#e6c370"/>
    <rect x="31" y="50" width="26" height="4.5" fill="#a8452f"/>
    {SHEEP.format(x=36, y=94, s=1.2, hx=-15)}
""")
ROLES["sheepdog"] = ("#1b3233", "#3ea8aa", "Sheepdog", f"""
    <path d="M16 120 C20 98 40 89 60 89 C80 89 100 98 104 120 Z" fill="#2b2f36"/>
    <path d="M40 120 C42 102 50 94 60 94 C70 94 78 102 80 120 Z" fill="{WHITE}"/>
    <path d="M33 50 L31 18 C38 22 46 30 52 38 Z" fill="#2b2f36"/><path d="M31 18 C35 18 40 22 41 28 C37 26 33 24 31 18 Z" fill="#454a54"/>
    <path d="M87 50 L89 18 C82 22 74 30 68 38 Z" fill="#2b2f36"/><path d="M89 18 C85 18 80 22 79 28 C83 26 87 24 89 18 Z" fill="#454a54"/>
    <ellipse cx="60" cy="56" rx="27" ry="27" fill="#2b2f36"/>
    <path d="M60 30 C63 40 66 48 70 56 C76 64 78 70 76 78 C72 88 66 92 60 92 C54 92 48 88 44 78 C42 70 44 64 50 56 C54 48 57 40 60 30 Z" fill="{WHITE}"/>
    <circle cx="45" cy="58" r="3" fill="#c8955a"/><circle cx="75" cy="58" r="3" fill="#c8955a"/>
    <circle cx="47" cy="50" r="4.2" fill="#d9a441"/>{eye(47, 50, 2.6)}
    <circle cx="73" cy="50" r="4.2" fill="#d9a441"/>{eye(73, 50, 2.6)}
    <path d="M54 70 C54 66 66 66 66 70 C66 74 62 76 60 76 C58 76 54 74 54 70 Z" fill="{INK}"/>
    <path d="M60 76 L60 81 M60 81 C57 84 53 83 51 81 M60 81 C63 84 67 83 69 81" stroke="{INK}" stroke-width="1.8" fill="none" stroke-linecap="round"/>
""")
ROLES["hunter"] = ("#1c2c21", "#3cb96a", "Hunter", f"""
    <path d="M18 104 L88 34" stroke="#3a3f47" stroke-width="5" stroke-linecap="round"/>
    <path d="M86 36 L94 28" stroke="#3a3f47" stroke-width="3" stroke-linecap="round"/>
    <path d="M10 112 L30 94 L38 101 L19 118 Z" fill="#8a5a34"/>
    <path d="M30 94 L44 80" stroke="#6b4426" stroke-width="7" stroke-linecap="round"/>
    <path d="M36 78 C34 40 86 40 84 78 Z" fill="#e0712c"/>
    <path d="M60 42 L60 78" stroke="#c25e1f" stroke-width="1.6"/>
    <rect x="35" y="68" width="50" height="7" rx="1.5" fill="#2b2f36"/>
    <path d="M33 78 C38 94 82 94 87 78 Z" fill="#c25e1f"/>
    <circle cx="60" cy="43" r="3" fill="#c25e1f"/>
    <path d="M78 70 C86 54 98 46 106 45 C100 54 92 64 81 72 Z" fill="#3ea8aa"/>
    <path d="M80 70 C89 58 97 50 104 47" stroke="#2e8a8c" stroke-width="1.2" fill="none"/>
""")
ROLES["coyote"] = ("#2b1d1d", "#d45f5f", "Coyote", f"""
    <path d="M30 54 L26 13 L55 37 Z" fill="#a8774a"/><path d="M33 47 L31 23 L48 37 Z" fill="#e2c9a6"/>
    <path d="M90 54 L94 13 L65 37 Z" fill="#a8774a"/><path d="M87 47 L89 23 L72 37 Z" fill="#e2c9a6"/>
    <path d="M60 30 C80 30 92 40 92 56 C92 66 84 72 76 78 L66 97 C64 101 56 101 54 97 L44 78 C36 72 28 66 28 56 C28 40 40 30 60 30 Z" fill="#b98a55"/>
    <path d="M60 30 C64 40 64 52 60 64 C56 52 56 40 60 30 Z" fill="#9a6e43"/>
    <path d="M42 66 C49 70 54 77 60 77 C66 77 71 70 78 66 L69 91 C67 97 53 97 51 91 Z" fill="#ead6b8"/>
    <path d="M40 53 C44 49 52 50 56 55 C51 58 45 58 40 53 Z" fill="#e9c24a"/><ellipse cx="49" cy="54.3" rx="1.6" ry="2.4" fill="{INK}"/>
    <path d="M80 53 C76 49 68 50 64 55 C69 58 75 58 80 53 Z" fill="#e9c24a"/><ellipse cx="71" cy="54.3" rx="1.6" ry="2.4" fill="{INK}"/>
    <ellipse cx="60" cy="92" rx="5.2" ry="3.8" fill="{INK}"/>
""")
ROLES["fox"] = ("#241f2d", "#7b68c8", "Fox", f"""
    <path d="M30 54 L28 14 L55 38 Z" fill="#d2692a"/><path d="M28 14 L36 21 L30 28 Z" fill="#2b2f36"/><path d="M34 46 L32 26 L47 37 Z" fill="#f2d7c2"/>
    <path d="M90 54 L92 14 L65 38 Z" fill="#d2692a"/><path d="M92 14 L84 21 L90 28 Z" fill="#2b2f36"/><path d="M86 46 L88 26 L73 37 Z" fill="#f2d7c2"/>
    <path d="M60 32 C80 32 92 42 92 56 C92 66 84 72 76 77 L64 96 C62 99 58 99 56 96 L44 77 C36 72 28 66 28 56 C28 42 40 32 60 32 Z" fill="#d2692a"/>
    <path d="M28 58 C34 70 46 74 54 80 L58 96 C59 98 61 98 62 96 L66 80 C74 74 86 70 92 58 C86 66 74 68 66 70 L60 76 L54 70 C46 68 34 66 28 58 Z" fill="{WHITE}"/>
    <path d="M41 53 C45 49 52 50 56 55 C51 58 46 58 41 53 Z" fill="#f0c44a"/><ellipse cx="49.5" cy="54.2" rx="1.3" ry="2.6" fill="{INK}"/>
    <path d="M79 53 C75 49 68 50 64 55 C69 58 74 58 79 53 Z" fill="#f0c44a"/><ellipse cx="70.5" cy="54.2" rx="1.3" ry="2.6" fill="{INK}"/>
    <ellipse cx="60" cy="93" rx="4.4" ry="3.4" fill="{INK}"/>
""")

for cid, (bg, title, art) in CHARS.items():
    (OUT / f"char-{cid}.svg").write_text(portrait(bg, "#3a3d44", art, title), encoding="utf-8")
for rid, (bg, ring, title, art) in ROLES.items():
    (OUT / f"role-{rid}.svg").write_text(portrait(bg, ring, art, title), encoding="utf-8")


# ── Night scene pieces: moon, stars, fence, grass, sheep, hidden eyes ──
def eyes(x, y, s=1.0, glow=True):
    g = f'<ellipse cx="{x + 7 * s}" cy="{y}" rx="{13 * s}" ry="{6 * s}" fill="#e9c24a" opacity=".18"/>' if glow else ""
    one = lambda ex: (f'<path d="M{ex - 4 * s} {y} C{ex - 2 * s} {y - 2.6 * s} {ex + 2 * s} {y - 2.6 * s} {ex + 4 * s} {y} '
                      f'C{ex + 2 * s} {y + 2.2 * s} {ex - 2 * s} {y + 2.2 * s} {ex - 4 * s} {y} Z" fill="#f0c44a"/>'
                      f'<ellipse cx="{ex}" cy="{y}" rx="{0.8 * s}" ry="{1.9 * s}" fill="{INK}"/>')
    return g + one(x) + one(x + 14 * s)


def sheep(x, y, s, face_left=True):
    hx = -15 if face_left else 15
    return SHEEP.format(x=x, y=y, s=s, hx=hx)


def grass(x, y, s, color="#2e8a8c"):
    return (f'<path d="M{x} {y} L{x - 6 * s} {y - 16 * s} M{x} {y} L{x} {y - 22 * s} M{x} {y} L{x + 7 * s} {y - 15 * s}" '
            f'stroke="{color}" stroke-width="{3 * s}" stroke-linecap="round" fill="none"/>')


def fence(x0, x1, y, post_h, n):
    step = (x1 - x0) / (n - 1)
    posts = "".join(f'<rect x="{x0 + i * step - 3:.1f}" y="{y - post_h}" width="6" height="{post_h}" rx="1.5" fill="#6b4a26"/>' for i in range(n))
    rails = (f'<rect x="{x0}" y="{y - post_h * 0.78:.1f}" width="{x1 - x0}" height="4" rx="2" fill="#7a5a2a"/>'
             f'<rect x="{x0}" y="{y - post_h * 0.42:.1f}" width="{x1 - x0}" height="4" rx="2" fill="#7a5a2a"/>')
    return rails + posts


stars_back = "".join(f'<circle cx="{x}" cy="{y}" r="{r}"/>' for x, y, r in
                     [(40, 40, 1.4), (70, 70, 1), (110, 36, 1.2), (30, 110, 1), (60, 140, 1.3), (130, 90, 1), (210, 150, 1.1), (100, 120, .9), (226, 34, 1)])
card_back = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 250 350" width="250" height="350" role="img" aria-label="Lanterns Out card back">
  <title>Lanterns Out card back</title>
  <rect width="250" height="350" rx="12" fill="#14161a"/>
  <rect x="0" y="0" width="250" height="5" rx="3" fill="#7b68c8"/>
  <rect x="6" y="6" width="238" height="338" rx="9" fill="none" stroke="#2e3035" stroke-width="1.5"/>
  <g fill="#c0c0bc" opacity=".55">{stars_back}</g>
  <path d="M176 48 a40 40 0 1 0 34 66 a32 32 0 0 1 -34 -66 z" fill="#9a8ae6"/>
  <path d="M6 236 C70 214 150 224 244 204 L244 335 C244 340 240 344 235 344 L15 344 C10 344 6 340 6 335 Z" fill="#1c2a24"/>
  {fence(22, 228, 236, 44, 5)}
  {sheep(70, 268, 1.7, True)}
  {sheep(178, 280, 1.5, False)}
  <path d="M6 300 C60 290 120 298 244 288 L244 335 C244 340 240 344 235 344 L15 344 C10 344 6 340 6 335 Z" fill="#17231e"/>
  {eyes(104, 312, 1.5)}
  {eyes(176, 322, 1.1)}
  {grass(36, 336, 1.3)}{grass(92, 330, 1.1)}{grass(150, 338, 1.2)}{grass(214, 332, 1.3)}{grass(124, 318, .9)}
</svg>
"""
(OUT / "card-back.svg").write_text(card_back, encoding="utf-8")

def dying_lantern(cx, base):
    """A lantern standing on a fence post, nearly out: guttering flame,
    faint glow, a curl of smoke. `base` is the y of the post top."""
    m = "#3a3f47"  # metal
    return f"""
    <circle cx="{cx}" cy="{base - 12}" r="26" fill="url(#lglow)"/>
    <path d="M{cx} {base - 33} C{cx - 7} {base - 41} {cx + 7} {base - 48} {cx} {base - 56} C{cx - 6} {base - 62} {cx + 4} {base - 68} {cx - 1} {base - 74}"
          stroke="url(#lsmoke)" stroke-width="2.2" fill="none" stroke-linecap="round"/>
    <path d="M{cx + 2} {base - 36} C{cx + 8} {base - 42} {cx + 3} {base - 47} {cx + 7} {base - 52}"
          stroke="url(#lsmoke)" stroke-width="1.3" fill="none" stroke-linecap="round"/>
    <path d="M{cx - 4} {base - 30} C{cx - 4} {base - 37} {cx + 4} {base - 37} {cx + 4} {base - 30}" stroke="{m}" stroke-width="1.8" fill="none"/>
    <path d="M{cx - 10} {base - 22} L{cx} {base - 31} L{cx + 10} {base - 22} Z" fill="{m}"/>
    <path d="M{cx - 8} {base - 3} L{cx - 7} {base - 22} L{cx + 7} {base - 22} L{cx + 8} {base - 3} Z" fill="#54461f"/>
    <ellipse cx="{cx}" cy="{base - 7}" rx="2.4" ry="3.6" fill="#e9c24a" opacity=".85"/>
    <ellipse cx="{cx}" cy="{base - 6}" rx="1.1" ry="1.6" fill="#f6e3a0"/>
    <path d="M{cx - 7.5} {base - 22} L{cx - 8.5} {base - 3} M{cx + 7.5} {base - 22} L{cx + 8.5} {base - 3} M{cx} {base - 22} L{cx} {base - 13}"
          stroke="#2b2f36" stroke-width="1.6"/>
    <rect x="{cx - 10}" y="{base - 4}" width="20" height="4.5" rx="1.2" fill="{m}"/>"""


# Post tops: fence(14, 346, 112, 38, 7) puts posts every 55.33 px, 38 tall.
LANTERN_X = round(14 + 2 * (346 - 14) / 6, 1)
stars_hero = "".join(f'<circle cx="{x}" cy="{y}" r="{r}"/>' for x, y, r in
                     [(30, 26, 1.3), (80, 50, 1), (160, 20, 1.2), (190, 44, 1), (250, 22, 1.4), (300, 58, .9), (40, 80, .9), (92, 64, 1.1), (226, 76, .9), (340, 30, 1.1)])
hero = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 180" width="360" height="180" role="img" aria-label="A lantern going out over the sheep pen at night, with coyote eyes in the grass">
  <title>A lantern going out over the sheep pen at night, with coyote eyes in the grass</title>
  <defs>
    <clipPath id="r"><rect width="360" height="180" rx="14"/></clipPath>
    <radialGradient id="lglow"><stop offset="0" stop-color="#e9c24a" stop-opacity=".28"/><stop offset="1" stop-color="#e9c24a" stop-opacity="0"/></radialGradient>
    <linearGradient id="lsmoke" gradientUnits="userSpaceOnUse" x1="0" y1="{112 - 38 - 33}" x2="0" y2="{112 - 38 - 74}">
      <stop offset="0" stop-color="#9a9da4" stop-opacity=".7"/><stop offset="1" stop-color="#9a9da4" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <g clip-path="url(#r)">
    <rect width="360" height="180" fill="#14161a"/>
    <g fill="#c0c0bc" opacity=".55">{stars_hero}</g>
    <path d="M286 22 a30 30 0 1 0 26 50 a24 24 0 0 1 -26 -50 z" fill="#9a8ae6"/>
    <path d="M0 112 C70 92 160 104 240 92 C290 85 330 90 360 96 L360 180 L0 180 Z" fill="#1c2a24"/>
    {fence(14, 346, 112, 38, 7)}
    <g transform="translate({LANTERN_X} 74) scale(1.3) translate({-LANTERN_X} -74)">{dying_lantern(LANTERN_X, 112 - 38)}</g>
    {sheep(68, 132, 1.5, True)}
    {sheep(150, 140, 1.3, True)}
    {sheep(262, 136, 1.45, False)}
    <path d="M0 150 C80 138 180 148 360 138 L360 180 L0 180 Z" fill="#17231e"/>
    {eyes(98, 160, 1.3)}
    {eyes(206, 166, 1.0)}
    {grass(26, 178, 1.1)}{grass(130, 174, 1.0)}{grass(178, 178, 1.2)}{grass(244, 176, 1.0)}{grass(318, 178, 1.2)}
  </g>
</svg>
"""
(OUT / "hero.svg").write_text(hero, encoding="utf-8")
print("wrote", sorted(p.name for p in OUT.iterdir()))
