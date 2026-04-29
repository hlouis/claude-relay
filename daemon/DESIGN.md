# Clay CI (Corporate Identity) Guidelines

---

## 1. Brand Identity

Clay는 **earthy warmth + vibrant accents** 의 조합이다.
칙칙하지 않으면서도 과하지 않은, 흙과 유약의 관계처럼
차분한 바탕 위에 선명한 포인트가 올라가는 느낌.

디자인 판단이 흔들릴 때 로고를 본다.

---

## 2. Logo System

### 2.1. Logo Origin

CLI 로고의 tri-accent 그레디언트에서 파생.
3개 컬러 스톱이 9줄에 보간되어 6색 밴드로 정제됨.

**CLI 원본 스톱 (3색):**

| Stop | Color | HEX | RGB |
|------|-------|-----|-----|
| Top | Green | `#09E5A3` | `9, 229, 163` |
| Mid | Indigo | `#5857FC` | `88, 87, 252` |
| Bottom | Terracotta | `#FE7150` | `254, 113, 80` |

### 2.2. Logo Band Colors (6색)

CLI 그레디언트를 균등 샘플링한 6색. Banded 버전과 아이콘에 사용.

| # | Name | HEX | RGB | 용도 |
|---|------|-----|-----|------|
| 1 | Vivid Green | `#00EBA0` | `0, 235, 160` | 상단 |
| 2 | Vivid Teal | `#00C8DC` | `0, 200, 220` | |
| 3 | Vivid Blue | `#1E64FF` | `30, 100, 255` | |
| 4 | Vivid Indigo | `#5832FF` | `88, 50, 255` | |
| 5 | Vivid Magenta | `#C83CB4` | `200, 60, 180` | |
| 6 | Vivid Terracotta | `#FF5A32` | `255, 90, 50` | 하단 |

> CLI 원본보다 채도를 높여 청명하게 조정. 탁하지 않고 쨍한 발색이 원칙.

### 2.3. Logo Variants

#### Wordmark (Clay 풀네임)

| Variant | 설명 | 파일 |
|---------|------|------|
| **Banded** | 6색 밴드, 명확한 경계 | `clay-wordmark-banded.png` |
| **Gradient** | 부드러운 색 전환 | `clay-wordmark-gradient.png` |

- 폰트: **Nunito Black**
- 구조: 글자 fill → 검정 스트로크 → 흰 스트로크 (안→바깥)
- 흰 스트로크가 보이도록 배경 대비 확보 필요

#### Icon (C 단독)

| Variant | 설명 | 파일 |
|---------|------|------|
| **Banded** | 6색 밴드 C | `icon-banded-{128,256,512,1024}.png` |
| **Gradient** | 부드러운 그레디언트 C | `icon-gradient-{128,256,512,1024}.png` |
| **Transparent** | 투명 배경 | `icon-{banded,gradient}-{256,512,1024}-transparent.png` |

- 동일한 3레이어 구조 (fill → black stroke → white stroke)

#### Favicon

| 파일 | 크기 | 용도 |
|------|------|------|
| `favicon-banded.png` | 16×16 | 브라우저 탭, 탑바 |
| `favicon-32.png` | 32×32 | 고해상도 탭 |
| `favicon-48.png` | 48×48 | 핀/북마크 |
| `favicon.ico` | multi | 레거시 호환 |

### 2.4. Logo Construction

```
┌─────────────────────────────────┐
│         White Stroke            │  ← 가장 바깥, 배경과 분리
│  ┌───────────────────────────┐  │
│  │      Black Stroke         │  │  ← 글자 윤곽 강조
│  │  ┌─────────────────────┐  │  │
│  │  │   Gradient/Band     │  │  │  ← 6색 fill (위→아래)
│  │  │   Fill              │  │  │
│  │  └─────────────────────┘  │  │
│  └───────────────────────────┘  │
└─────────────────────────────────┘
```

**스트로크 비율 원칙:**
- White stroke : Black stroke ≈ 2:1
- 스트로크 총 두께는 글자 획 두께의 약 15–20%

### 2.5. Logo Usage Rules

1. **Primary**: Banded 버전. 공식 로고, UI 탑바, 파비콘.
2. **Secondary**: Gradient 버전. 마케팅, 프레젠테이션 등 부드러운 인상이 필요할 때.
3. **최소 크기**: 아이콘 16px, 워드마크 높이 14px 이하로 축소 금지.
4. **배경 제한**: 흰색 또는 밝은 회색 위 권장. 어두운 배경에서는 투명 버전 사용.
5. **변형 금지**: 색상 순서 변경, 회전, 그림자 추가, 스트로크 제거 불가.
6. **간격**: 로고 주변에 C 높이의 50% 이상 여백 확보.

### 2.6. Favicon Animation

경고/주목 필요 시 파비콘에 color flow 애니메이션 적용:

- **방식**: 6색 밴드가 위→아래로 순차적으로 흐름 (canvas 기반)
- **속도**: ~12fps (83ms 간격)
- **용도**: permission 요청, user input 필요 등 urgent 상태에서만
- **복원**: 상태 해제 시 즉시 정적 파비콘으로 복원

---

## 3. Typography

### Primary: Nunito
- **용도**: 로고, 탑바 브랜딩
- **Weight**: Black (900) — 로고 전용
- **Weight**: Bold (700), ExtraBold (800) — UI 헤딩

### Secondary: Roboto Mono
- **용도**: 코드, 터미널, 상태 텍스트
- **Weight**: Regular (400), Medium (500)

---

## 4. Color System

### 4.1. Accent Palette (Coolors)

세 가지 악센트 그룹, 각각 3단계 밝기:

| Group | Bright | Mid | Deep |
|-------|--------|-----|------|
| Green | `#09E5A3` | `#00B785` | `#066852` |
| Blue  | `#5857FC` | `#2A26E5` | `#1C1979` |
| Red   | `#FE7150` | `#F74728` | `#BA2E19` |

### 4.2. Body Palette (Coolors)

Clay/rose 톤. Light 테마의 base00-02 근거:

| Light | Mid | Deep |
|-------|-----|------|
| `#DAC7C4` | `#D6B6B0` | `#C0A9A4` |

### 4.3. Base16 Slot Mapping

| Slot | Role | Light picks from | Dark picks from |
|------|------|-------------------|-----------------|
| base00-02 | Background tones | Clay/rose body | Warm brown body |
| base03-05 | Text hierarchy | Warm grays | Warm grays, brighter |
| base08 | Error / destructive | Deep red | Mid red |
| base09 | **Primary accent** (terracotta) | Mid red | Bright red |
| base0A | Warning / yellow | Warm gold | Warm gold, saturated |
| base0B | Success / green | Deep green | Bright green |
| base0C | Info / teal | Deep teal | Teal |
| base0D | Links / blue | Rich blue | Bright blue |
| base0E | Special / purple | Muted purple | Saturated purple |
| base0F | Misc / brown | Clay brown | Clay brown |
| accent2 | **Secondary accent** (indigo) | Mid blue | Bright blue |

### 4.4. Light vs Dark

- **Light**: 밝은 배경에 **짙은** 악센트. 팔레트에서 Mid~Deep 레벨.
- **Dark**: 어두운 배경에서 Bright~Mid 레벨. Light보다 한 단계 밝고 saturated.

---

## 5. Accent System

### `--accent` (base09, terracotta)
주요 인터랙션 컬러. 버튼, 링크 호버, 프로그레스 바, 포커스 링.

### `--accent2` (indigo)
정보/상태 표시 컬러:
- Activity text ("Photosynthesizing..." 등)
- User island avatar
- AskUserQuestion 선택 하이라이트
- Tool link hover, file history badge
- Session info copy button

Thinking block에는 accent2를 **쓰지 않는다** (overlay-rgb 기반 유지).

---

## 6. Selection

텍스트 드래그 선택: `rgba(9, 229, 163, 0.25)` — Green 고정.
테마에 따라 변하지 않는 유일한 하드코딩 컬러.

---

## 7. Rules

1. **하드코딩 금지** — 모든 컬러는 CSS custom property(`var(--xxx)`)를 통해 참조. Selection만 예외.
2. **로고가 기준** — 색이 맞는지 모르겠으면 로고와 나란히 놓고 본다.
3. **대비 확보** — 배경을 어둡게 내리면 텍스트도 같이 올린다. base03(dimmer)이 배경 대비 최소 4:1.
4. **accent2 남용 금지** — 정보/상태 표시에만 쓴다. 주요 인터랙션은 accent.
5. **테마 파일 네이밍** — `clay-*.json`. claude가 아닌 clay.
6. **로고 색상 순서 고정** — Green → Teal → Blue → Indigo → Magenta → Terracotta. 순서 변경 불가.
7. **로고 3레이어 구조 유지** — fill → black stroke → white stroke. 레이어 생략 불가.

---

## 8. Asset Inventory

```
design/media/logo/
├── clay-wordmark-banded.png          # Primary wordmark
├── clay-wordmark-gradient.png        # Secondary wordmark
├── icon-banded-{128..1024}.png       # Banded C icon (solid bg)
├── icon-gradient-{128..1024}.png     # Gradient C icon (solid bg)
├── icon-*-transparent.png            # Transparent background variants
├── favicon-{16,32,48}.png            # Favicon PNGs
└── favicon.ico                       # Multi-size ICO

main/lib/public/
├── favicon-banded.png                # Active favicon (16×16)
├── wordmark-banded-{20,32,64}.png    # Topbar wordmark
├── apple-touch-icon.png              # iOS icon (180×180)
├── apple-touch-icon-dark.png         # iOS icon dark
├── icon-192.png / icon-512.png       # PWA icons
└── icon-192-dark.png / icon-512-dark.png
```
