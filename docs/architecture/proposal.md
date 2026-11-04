# Draw: architecture and feasibility proposal

Status: **proposal for review**. No application code is written until this
document is accepted. Decisions that need an owner are collected in §7.

Working names used below:
- **Draw** for the application.
- **`.drawx`** for its native file format. This is a placeholder; check for
  conflicts with existing file types before release.

---

## 0. Executive summary

| Question | Recommendation | Confidence |
| --- | --- | --- |
| Desktop shell | **Electron.** Tauri's system webviews give three different rendering engines, one per OS. That is the wrong foundation for an application whose core product is pixel-accurate rendering. | High |
| Rendering | A **renderer-independent display list**. The first backend draws with **Canvas 2D** (Chromium's GPU-accelerated Skia). SVG and PDF export consume the same display list. Cached per-node geometry plus a spatial index handle scale. A GPU backend is added only if profiling demands it. | High for the abstraction, medium for the long-term backend |
| Document model | A **normalized node table of immutable records**. It is changed only through **transactions of reversible primitive operations**. The document is plain data, separate from editor/session state (selection, viewport, tool). | High |
| Undo/redo | **Inverse-operation transactions.** Drag gestures coalesce into one entry. Selection is restored with the entry. Inverse-operation history also enables autosave, crash recovery and possible future collaboration. | High |
| Interaction | An input pipeline feeds **tools written as explicit state machines**. Tools talk only to services (hit testing, snapping, selection, viewport, transactions), never to the renderer or the UI. | High |
| UI | React, isolated behind the editor's public store API. The canvas is not rendered through React. | Medium. Preact or Solid are acceptable swaps. |
| Native format | A ZIP container holding a versioned JSON document, binary resources and a preview image. It has explicit `formatVersion` and `minReaderVersion` fields and a tested migration chain. | High |
| Interop | Importers and exporters are adapters behind one interface, run off the UI thread, and return a structured import report. The **CDR reader is kept as an experimental importer, verified only for CorelDRAW X5**. SVG import/export and PDF export are early; PDF import is later. | High |
| First usable milestone | After roadmap phases 0–3: a packaged desktop app that creates, edits, saves and reopens vector drawings with undo/redo. | — |

The highest-risk subsystems are **text**, **Boolean path operations**, **PDF
import** and **colour management**. They are scheduled deliberately late and
behind spikes, so they never block a usable editor.

---

## 1. Repository assessment

### 1.1 Git state

- Branch `claude/compassionate-noether-lpjlk6` has **one commit, `d203482`,
  that exists only in this local clone**. The push was rejected with HTTP 403:
  the Claude GitHub App has no access to `canva4smartkids-jpg/draw`. The
  remote has none of this work until access is granted and the commit is
  pushed.
- The working tree is clean.
- The repository has no CI configuration, no licence, and `package.json` is
  marked `private`.

### 1.2 What actually exists

About 1,690 lines of library JavaScript in `src/` (ES modules, no
dependencies, no build step; `cdr.js` alone is 952), plus about 230 lines of
CLI and viewer, about 440 lines of tests, and about 390 lines of
documentation.

| Path | Lines | What it does | Reuse verdict |
| --- | ---: | --- | --- |
| `src/binary.js` | 87 | Bounds-checked little-endian reader; `FormatError` | **Keep.** Port to TS; shared by all binary importers. |
| `src/inflate.js` | 49 | zlib/raw-deflate via `DecompressionStream`, output-size cap | **Keep.** Port; shared. |
| `src/zip.js` | 82 | ZIP central-directory reader (stored/deflate; no ZIP64, no writing) | **Keep and extend.** Needs a writer and ZIP64 for the native format. |
| `src/riff.js` | 135 | RIFF tree reader with CorelDRAW `cmpr` handling | **Keep.** Moves into the CDR importer. |
| `src/cdr.js` | 952 | CDR container/version detection; pages, layers, objects, fills, outlines, style table, lens | **Keep as the importer core.** Must gain an adapter to the native model. |
| `src/color.js` | 119 | Colour-model → sRGB conversions (no ICC) | **Partly reusable** as conversion helpers in a future colour package. |
| `src/path.js` | 125 | Affine matrices, arc → cubic, loose bounds, SVG path data | **Seed for the geometry package.** Most geometry is missing (§1.4). |
| `src/svg.js` | 131 | SVG string output, directly from the CDR model | **Retire later.** Superseded by an SVG exporter that reads the display list; keep as a golden reference until then. |
| `bin/cdr2svg.js` | 101 | CLI: convert, `--info`, `--json`, `--tree` | **Keep as a developer tool** under `tools/`. |
| `web/index.html`, `scripts/serve.js` | 131 | Drag-and-drop viewer, local static server | **Retire** once the desktop app opens CDR files. Useful as a debug viewer meanwhile. |
| `test/helpers/build.js` | 184 | Builders that synthesise CDR records and ZIP files | **Keep** in a test-kit package. |
| `docs/cdr-format.md`, `docs/rea-analysis.md` | 386 | Format notes with confidence levels; REA workflow | **Keep** under `docs/formats/`. |

### 1.3 Tests and their real coverage

18 tests pass on Node 22. Measured with `node --test --experimental-test-coverage`:

| Scope | Line | Branch | Functions |
| --- | ---: | ---: | ---: |
| All `src/`, synthetic tests only (CI without fixtures) | 79.0% | 69.8% | 81.5% |
| All `src/`, with the three real files fetched | 88.0% | 74.0% | 89.7% |
| `src/cdr.js`, synthetic only | 72.3% | 59.2% | 71.9% |
| `src/svg.js`, synthetic only | 67.2% | 39.3% | 62.5% |

The numbers flatter the code in three ways:

1. **The synthetic tests share the parser's assumptions.** `build.js` writes
   records using the same layout beliefs the reader decodes. These tests prove
   internal consistency and catch regressions; they do not prove correctness
   against CorelDRAW.
2. **Only one real drawing exists**: CorelDRAW X5, five rectangles, one lens.
   It verifies rectangles, solid RGB/CMYK fills, outlines, the style table,
   layers and the invert lens. The other two real files only test rejection
   (a fuzzed file and a CMX file).
3. **Uncovered or unverified paths** include:
   - groups, PowerClip containers and the X6+ out-of-line streams
   - CorelDRAW 4-era colours and pre-X3 record layouts
   - polygons, rounded/scallop/chamfer corners and gradients (parsed but never
     rendered by a test)
   - pre-X3 lenses and every SVG gradient branch

### 1.4 Architectural limitations

The current code is a **file reader**, not an editor foundation:

1. **Import model, not an editing model.** Objects carry CDR-specific fields
   such as raw flags, hex ids and `_parent`, and the style indirection is
   CorelDRAW's. Paths are pre-transformed into page space alongside the local
   geometry. There is no stable object identity, no mutation API and no
   change notification.
2. **Conventions that differ from the proposed native model.**
   - CDR: millimetres, origin at the page centre, y up, top-most object first.
   - Native (proposed, §3.4): points, origin at top-left, y down, painter's
     order.
   - The importer adapter must convert all of these explicitly.
3. **Geometry is minimal.** It has no tight Bézier bounds (it uses control
   points), no hit testing, flattening or curve intersection, and no
   arc-length or nearest-point functions. Boolean operations and stroke
   outlining are absent.
4. **The SVG renderer is not a rendering engine.** It concatenates strings
   from the CDR model and has no display list, caching, culling or viewport.
   Gradient placement is approximate.
5. **Colour** uses device-naive CMYK and shows spot colours as grey. It has
   no ICC handling.
6. **Errors are unstructured.** Warnings are free-text strings. An import
   report UI needs warning codes, counts and the objects affected.
7. **No engineering scaffolding.** There is no TypeScript, type checking,
   linting, CI, packaging or licence decision.
8. **CDR scope is narrow and must stay labelled.**
   - **Verified:** X5.
   - **Implemented but untested:** X6+, pre-X4, groups, polygons, gradients.
   - **Not decoded:** text, bitmaps, pattern/texture fills, PowerClip,
     envelopes.

   The product must say "experimental CDR import, verified with CorelDRAW X5
   files" until more legitimately obtained samples prove otherwise.

---

## 2. Technology evaluation

### 2.1 Electron vs Tauri

| Criterion | Electron | Tauri 2 |
| --- | --- | --- |
| **Rendering engine** | Bundled Chromium: identical Canvas 2D, WebGL and WebGPU behaviour on Windows, macOS and Linux. | System webview: WebView2 (Chromium) on Windows, WKWebView (WebKit) on macOS, WebKitGTK on Linux. **Three engines** with different anti-aliasing, blend-mode, filter and GPU behaviour. Tauri's own docs warn that on Linux, canvas/WebGL content can silently fall onto slow or software paths, and recommend a non-WebGL fallback. |
| **Rendering consistency over time** | You choose when Chromium changes (each Electron upgrade). | WKWebView's version follows the user's macOS version, so older macOS means older WebKit. Output can differ between two users on the same app version. |
| **Startup, memory, installer size** | Heavier: Chromium plus Node per app; installers are typically 100 MB+. | Much lighter: a few MB plus the system webview. |
| **Back-end language** | TypeScript/Node everywhere; native addons via N-API (e.g. Rust through napi-rs) when needed. | Rust. Strong ecosystem for geometry and rendering (kurbo, lyon, Vello, usvg/resvg, PDF writers), at the cost of a second language and IPC serialisation for heavy data. |
| **Security model** | Safe when configured: context isolation, sandboxing, no Node in the renderer, a validated IPC surface, CSP. Requires discipline. | Capability-based permissions by default. Stronger out of the box. |
| **Automated UI testing** | Playwright drives Electron directly (its Electron API is labelled experimental but widely used). | WebDriver via `tauri-driver` on Windows and Linux only; no macOS driver for WKWebView. |
| **Release cadence and maintenance** | A new major every 8 weeks, tracking Chromium; only recent majors get security fixes, so expect regular upgrade work. | Slower framework churn. Webview security updates come from the OS. |
| **Chromium inside Tauri** | n/a | A CEF runtime exists only as a **community crate in alpha** (`tauri-runtime-cef` 3.0.0-alpha.6, Oct 2026, targeting Tauri 3 alpha). Upstream Tauri does not ship it, so it is not a basis for a product decision today. |
| **Packaging, updates, file associations, signing** | Mature: electron-builder or Electron Forge, auto-update, NSIS/DMG/AppImage/deb, macOS notarisation. | Good: built-in bundler and updater. |

**Recommendation: Electron.** For a vector editor, the deciding criterion is
that the same document renders identically, at full GPU speed, on every
platform. That guarantee also makes golden-image tests meaningful: one engine,
one set of reference images. Tauri's real advantages (size, memory, a Rust
backend) matter less for a professional desktop tool whose peers ship
installers measured in gigabytes.

**Keeping the door open.** Only `apps/desktop/src/main` and `src/preload` may
import Electron. Everything else talks to a `DesktopApi` interface. A later
move to Tauri (for example once an official Chromium runtime ships) would
replace the shell and that adapter, not the editor. The same seam also lets
the editor run in a plain browser for development and tests.

**Revisit if:**
- an official, stable Tauri Chromium runtime ships;
- the team decides to move the geometry/render core to Rust/WASM anyway;
- installer size becomes a measured adoption problem.

### 2.2 Rendering approaches

| Approach | Strengths | Weaknesses | Verdict |
| --- | --- | --- | --- |
| **SVG DOM** (one element per object) | Trivial to start; the browser does hit testing. | DOM cost grows with object count; little control over caching and precision; hard to draw handles and overlays efficiently. | Prototype only. |
| **Canvas 2D** | Zero dependencies. GPU-accelerated Skia in Chromium. Covers `Path2D`, even-odd and non-zero fills, dashes, gradients, all separable blend modes, blur and drop-shadow filters. | Immediate mode: we own culling, caching and dirty tracking. Skia uses 32-bit floats internally, so deep zoom needs CPU-side transform to device space. | **v1 backend.** |
| **WebGL2, custom** (tessellate paths, e.g. a port of lyon-style tessellation) | Full control; fast for huge static scenes. | Anti-aliasing quality, strokes, dashes, gradients and blend modes must all be rebuilt. Months of work to reach Canvas 2D quality. | Not justified now. |
| **WebGPU compute** (a Vello-style renderer) | Highest ceiling for very large scenes. | Research-grade engineering; a dependency on a young Rust/WASM stack, or a from-scratch port. | Possible future backend, only on measured need. |
| **CanvasKit** (Skia compiled to WASM) | Identical output in any host, including headless Node (deterministic raster tests). Ships Skia **PathOps** (Boolean operations), stroke-to-path and a paragraph/text engine. | Several MB of WASM; Skia's float precision; a large API surface; its rendering duplicates what Chromium already does natively. | **Evaluate in a spike** as a geometry/text kernel and test rasteriser (§4, phases 8–9), not as the main renderer. |
| **Native Rust** (Tauri plus wgpu/Vello in a native surface) | Native performance. | Compositing a native GPU surface under a webview UI is immature and platform-specific. | Rejected with Tauri. |

**Recommendation.** The rendering engine produces a **display list**: an
ordered list of draw commands with resolved geometry, paint, clip, opacity,
blend mode and effects in world space. Backends only execute display lists:

- `canvas2d`: on-screen rendering and PNG export.
- `svg`: SVG export.
- `pdf`: PDF export.
- Possibly `webgpu` or `canvaskit` later.

What you see and what you export share one code path. Display lists are
plain data, so most render tests run headless without a GPU.

### 2.3 Document model approaches

| Approach | Pros | Cons |
| --- | --- | --- |
| **Mutable object graph** (classes with setters) plus command objects | Familiar. | Easy to mutate state outside the history; aliasing bugs; hard to diff for rendering invalidation. |
| **Immutable snapshots of the whole tree** (structural sharing) | Undo is "keep the old root"; equality checks are cheap. | Memory and churn on large documents; nested trees make reparenting and lookup by id awkward. |
| **Normalized table of immutable node records plus primitive operations** | Lookup by id is O(1). Reparenting is one operation. Every change is a small, serialisable, invertible record, so history, autosave journal, dirty tracking, change notification and future collaboration all come from one mechanism. | Requires discipline: all writes go through the transaction API (enforceable by types and lint). |
| **CRDT** (Yjs/Automerge) as the store | Collaboration built in. | Heavy runtime dependency; performance and memory overhead on large geometry; collaboration is not a requirement. |

**Recommendation: a normalized table of immutable records plus primitive
operations.** Stable random ids and ordered child arrays keep a CRDT layer
possible later without changing the model.

### 2.4 Undo/redo approaches

| Approach | Verdict |
| --- | --- |
| **Command pattern** (each command implements `do`/`undo`) | Every command must hand-write a correct inverse; bugs are silent. Rejected as the base mechanism; commands *compose* operations instead. |
| **Snapshots per step** | Simple, but memory-heavy for big documents, and it cannot produce journals for autosave. |
| **Inverse-operation transactions** | **Chosen.** Each primitive operation computes its inverse when applied, so higher-level commands get undo for free. Property tests can check the whole system: any random operation sequence, undone, restores the original document exactly. |

Rules:

- **One transaction is one history entry.**
- **Drags are live.** A drag opens a transaction, updates its operations each
  pointer move (the document changes live, so inspector and renderer stay
  truthful), then commits on pointer-up or rolls back on Escape.
- **Typing coalesces.** Consecutive inspector edits to the same property
  within a short window merge into one entry.
- **Selection travels with the entry.** Each entry stores selection before
  and after, and undo restores it. Viewport and tool are never part of
  history.
- **Dirty state** is a pointer to the history position at last save.

### 2.5 Interaction system

- DOM events are normalised once into `InputEvent` records: screen and world
  coordinates, buttons, modifiers, pressure, timestamp, coalesced pointer
  samples.
- A **gesture layer** turns raw events into click, double-click and drag
  (with a threshold in screen pixels), and handles temporary tool overrides:
  space to pan, Ctrl/Cmd to zoom, Alt.
- **Tools are explicit state machines.** For example, Select has these
  states: `Idle → PendingPress → Moving | Scaling | Rotating | Marquee`.
  - Each state handles events and may draw overlays.
  - Tools reach the world only through services: `HitTester`, `Snapper`,
    `Selection`, `Viewport`, `Transactions`, `Commands`.
  - Tools are therefore unit-testable by feeding synthetic `InputEvent`
    sequences to a headless editor and asserting on document and selection.
- **Commands** (`edit.undo`, `object.group`, `view.zoomToFit`, …) live in one
  registry with labels, enablement predicates and default key bindings.
  Native menus, the command palette, toolbar buttons and shortcuts all
  dispatch through it. Key maps are data, platform-aware (Cmd vs Ctrl) and
  user-overridable.

### 2.6 UI framework

| Option | Notes |
| --- | --- |
| **React** | Largest talent pool and tooling; `useSyncExternalStore` binds cleanly to an external editor store. Its runtime size is irrelevant on desktop. **Recommended.** |
| Preact (with signals) | Same model, smaller. A fine choice if the team prefers it. |
| SolidJS | Fine-grained updates suit inspectors; smaller ecosystem. |
| Vanilla TS | No dependency, but panels, trees and forms become a home-grown framework. |

Whichever is chosen, the framework only renders panels, toolbars, dialogs and
tabs. **The canvas is a host element owned by the render engine.** The editor
core has no framework import, so the framework can be replaced without
touching the engine. No heavyweight component library: the panels need a
small in-house design system (CSS variables, light/dark themes) to give the
app its own visual identity.

### 2.7 Build and test tooling (dependency budget)

| Purpose | Choice | Ships to users? | Justification |
| --- | --- | --- | --- |
| Shell | `electron` | yes | §2.1 |
| UI | `react`, `react-dom` | yes | §2.6 |
| Language | `typescript` (strict) | no | Required |
| Bundling | `vite` (renderer), `esbuild` (main/preload; bundled with Vite) | no | Fast dev loop with HMR |
| Packaging | `electron-builder` (alternative: Electron Forge; decide in a Phase 0 spike) | no | Installers, auto-update, signing |
| Unit tests | `vitest` | no | TS-native, watch mode, V8 coverage. (`node:test` plus type stripping is the zero-dependency alternative.) |
| E2E and golden images | `@playwright/test` | no | Drives Electron; screenshot comparison |
| Lint/format | ESLint + typescript-eslint + Prettier, or Biome alone | no | Type-aware lint rules enforce the architecture |
| Later, behind spikes | HarfBuzz WASM (text shaping), a polygon clipper or CanvasKit PathOps (Booleans), pdf.js (PDF import) | yes | Each is a hard, solved problem; adopt rather than reinvent. Each needs a licence check. |

Any dependency outside this table needs a short ADR (architecture decision
record) in `docs/architecture/adr/`.

---

## 3. Architecture

### 3.1 Process model

```
┌──────────────────────────── Electron main process (Node) ────────────────────────────┐
│ app lifecycle · windows · native menus · dialogs · file I/O (atomic save)             │
│ recent files · file associations · autosave store · crash recovery · auto-update     │
│ IPC handlers: validated, typed by apps/desktop/src/shared/ipc.ts                     │
└───────────────▲──────────────────────────────────────────────────────▲───────────────┘
                │ contextBridge (DesktopApi: no raw ipcRenderer)       │ MessagePort
┌───────────────┴──────────── renderer process (sandboxed) ────────────┴───────────────┐
│ UI shell (React): workspace layout · tabs · toolbars · inspector · layers · dialogs   │
│        │ subscribes / dispatches                                                     │
│        ▼                                                                             │
│ Editor core (per document tab: session = document store + history + editor state)    │
│        │ change sets                                                                 │
│        ▼                                                                             │
│ Render engine → display list → Canvas 2D backend (document canvas + overlay canvas)  │
└───────────────────────────────────────────────▲─────────────────────────────────────┘
                                                │ transferable ArrayBuffers
                          ┌─────────────────────┴──────────────────────┐
                          │ worker: import/export (CDR, SVG, PDF, PNG)  │
                          │ untrusted input parsed here, with limits    │
                          └─────────────────────────────────────────────┘
```

**Security defaults:**
- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`;
- a strict CSP; no remote content;
- navigation and new windows denied;
- IPC sender and argument validation.

File bytes cross IPC as `ArrayBuffer`. Parsing never runs in the main process.

### 3.2 Package layering

Arrows point to dependencies. Lower layers never import higher ones; a CI
script enforces this.

```
                 apps/desktop (main · preload · renderer UI)
                        │                 │
                        ▼                 ▼
                     editor ─────────► render ──────────┐
                        │                 │             │
                        ▼                 ▼             ▼
   format-native ──► document ───────► geometry      color
        │               ▲                 ▲             ▲
        ▼               │                 │             │
   archive (zip)    io-cdr · io-svg · io-pdf · io-raster ──┘
        ▲                   │        (exporters depend on render's display list)
        └───────────────────┘
```

| Package | Responsibility | May depend on |
| --- | --- | --- |
| `geometry` | Pure math. No dependencies, no DOM. | — |
| `color` | Colour values, spaces and conversions; later ICC. | — |
| `document` | Schema, node types, ids, operations, transactions, history, change sets, validation, JSON (de)serialisation, migrations. | `geometry`, `color` |
| `archive` | ZIP read/write (grown from today's `zip.js`, `inflate.js`, `binary.js`). | — |
| `format-native` | The `.drawx` container: manifest, versioning, resources, preview. | `document`, `archive` |
| `render` | Scene cache, display-list builder, spatial index, viewport math, backends (`canvas2d` needs a canvas; `svg` and `pdf` builders are pure). | `document`, `geometry`, `color` |
| `editor` | Sessions, selection, tools, input pipeline, snapping, hit testing, commands, key maps, clipboard model. **No DOM, React or Electron imports.** | `document`, `render` (scene queries, overlays), `geometry` |
| `io-*` | Importers/exporters behind one adapter interface. | `document`, `geometry`, `color`, `archive`; exporters also `render` |
| `testkit` | Document factories, seeded RNG, golden-file helpers, CDR record builders. | everything (tests only) |

### 3.3 Geometry engine (`packages/geometry`)

Float64 throughout; tolerances are explicit parameters, never globals.

- **Primitives:** `Vec2`, `Mat2D` (affine: compose, invert, decompose into
  translate/rotate/scale/skew), `Rect`.
- **Curves:** line, quadratic and cubic Bézier segments.
  - Evaluation, derivatives, splitting.
  - Extrema, giving **tight bounds**.
  - Arc length and nearest point.
  - Flattening to a tolerance.
  - Line/curve and curve/curve intersection.
  - Elliptical arc to cubic (seeded from today's `arcToCubics`).
- **Paths:** subpaths of segments with `closed` flags and a fill rule.
  - Point-in-fill (non-zero and even-odd winding).
  - Distance-to-stroke hit testing.
  - Reverse, close/open, join, break at node.
  - Transform, bounds.
- **Shapes to paths:** rectangle with per-corner radius and corner type,
  ellipse/arc/pie, regular polygon/star, line.
- **Curve fitting** for the pencil tool (least-squares cubic fitting with an
  error bound).
- **Later, behind an interface:** stroke outlining (expand stroke), offset
  path, and **Boolean operations** (union, subtract, intersect, exclude,
  divide). Candidates are evaluated in a spike against a shared test corpus
  (§4, phase 8).

### 3.4 Document model (`packages/document`)

Conventions, fixed in schema v1:

| Convention | Choice | Why |
| --- | --- | --- |
| Internal unit | **point** (1/72 in), float64 | Matches PDF and print workflows; display units (mm, cm, in, px, pt, pica) are a view setting |
| Axes | x right, **y down**, origin top-left of each artboard | Matches SVG, Canvas and PDF-after-flip; importers convert |
| Child order | arrays in **painter's order** (index 0 = bottom) | Matches rendering; the CDR importer reverses its top-first order |
| Ids | 128-bit random, base32 strings, created with `crypto.getRandomValues` | Stable across save/load, unique across documents (safe paste) |
| Geometry | stored in **local coordinates**, plus a per-node `Mat2D` | Editing needs local geometry; the world transform is derived |

Model sketch (TypeScript; names indicative):

```ts
type NodeId = string & { readonly __brand: 'NodeId' };

interface DocumentState {
  readonly schemaVersion: number;
  readonly meta: DocumentMeta;                  // title, author, units, created/modified
  readonly artboards: readonly ArtboardId[];
  readonly root: NodeId;                        // root layer stack
  readonly nodes: ReadonlyMap<NodeId, Node>;    // normalized table
  readonly resources: Resources;                // swatches, gradients, images, fonts (by id)
}

type Node = LayerNode | GroupNode | PathNode | RectNode | EllipseNode
          | PolygonNode | TextNode | ImageNode;  // + ClipGroup, SymbolInstance later

interface NodeBase {
  readonly id: NodeId;
  readonly parent: NodeId | null;
  readonly name?: string;
  readonly transform: Mat2D;
  readonly visible: boolean;
  readonly locked: boolean;
  readonly opacity: number;           // 0..1
  readonly blendMode: BlendMode;
  readonly appearance: Appearance;    // ignored by containers in v1
}

interface Appearance {               // an ordered stack, as in pro tools
  readonly fills: readonly Paint[];   // none | solid | linear | radial | (pattern later)
  readonly strokes: readonly Stroke[];
  readonly effects: readonly Effect[]; // drop shadow, blur, … (v2+)
}

interface RectNode extends NodeBase {   // a live, parametric shape
  readonly type: 'rect';
  readonly width: number;
  readonly height: number;
  readonly corners: readonly [Corner, Corner, Corner, Corner];
}
```

- **Live shapes** (rectangle, ellipse, polygon/star) remain parametric until
  the user runs *Convert to curves*, which materialises a `PathNode`. The CDR
  importer maps CorelDRAW rectangles and ellipses to live shapes, keeping
  them editable.
- **Colours** are typed values (`{space:'srgb', r,g,b}`,
  `{space:'cmyk', c,m,y,k}`, `{space:'spot', swatch}`) with optional alpha.
  Global swatches are resources referenced by id, so editing a swatch updates
  every user.
- **Artboards** live in one shared world space with an unbounded pasteboard.
  This allows several artboards on screen at once and an infinite workspace.
  Each artboard can be exported as a page. (Single-page-at-a-time navigation
  is the alternative; see §7.)

**Primitive operations.** Every operation is serialisable and carries enough
data to build its exact inverse:

| Operation | Inverse |
| --- | --- |
| `insert(node, parent, index)` | `remove` |
| `remove(id)` (captures the whole subtree) | `insert` (subtree) |
| `set(id, key, value)` (records the old value) | `set(old)` |
| `move(id, newParent, newIndex)` (records the old position) | `move` back |
| `setResource` / `removeResource` | symmetric |

**Invariants** are checked in debug builds and in property tests:
- the tree is acyclic;
- every `parent` and `children` entry agree;
- ids are unique;
- referenced resources exist;
- numbers are finite.

**Change sets.** After every apply or commit, the store emits the set of
changed node ids with the kind of change. The render scene cache, the layers
panel and the inspector all react to these. No consumer diffs whole
documents.

### 3.5 History (`packages/document/history`)

```ts
interface Transaction { label: string; ops: Op[]; inverse: Op[];
                        selectionBefore: NodeId[]; selectionAfter: NodeId[]; mergeKey?: string; }
interface History { begin(label, opts?): TxHandle; commit(tx): void; rollback(tx): void;
                    undo(): void; redo(): void; canUndo: boolean; canRedo: boolean;
                    markSaved(): void; isDirty: boolean; entries(): readonly HistoryEntry[]; }
```

- The stack is linear. A new commit after undo truncates the redo branch.
- Size is bounded by entry count and by estimated memory.
- `mergeKey` coalesces related edits: drags, nudges, and typing into one
  inspector field.
- The history panel (later) is a read-only view of `entries()` with "jump to
  state".

### 3.6 Rendering engine (`packages/render`)

```
 document change set
        │
        ▼
 SceneCache: per node, cached and invalidated by change sets
   · world transform (from the ancestor chain)
   · resolved geometry (live shape → path) in world space
   · tight bounds, plus stroke and effect inflation
   · resolved paints (swatch → colour, gradient → stops)
        │                          │
        ▼                          ▼
 SpatialIndex (R-tree)       DisplayListBuilder(viewport)
   culling, hit-test            ordered DrawItems: path, paint,
   candidates                   clip, opacity, blend, effects
        │                          │
        ▼                          ▼
 editor HitTester           Backend.execute(displayList, surface)
                              canvas2d (screen, PNG) · svg · pdf
```

**Two stacked canvases:**
- the document canvas, redrawn only when the document or viewport changes;
- the overlay canvas: selection box, handles, path nodes, snapping guides,
  hover outline, marquee. It redraws on every pointer move without touching
  the document layer.

**Viewport.** World ↔ screen transform; zoom range about 1% to 64,000%. Pan
via wheel, trackpad, space-drag and the hand tool. Commands: zoom to fit,
selection and 100%.

**Deep-zoom precision.** Above a zoom threshold, geometry is transformed to
device space in float64 on the CPU before being handed to Canvas 2D, which
avoids Skia's 32-bit float jitter.

**Performance budgets** (each with a CI benchmark):

| Scenario | Target |
| --- | --- |
| Pan/zoom, 10k objects | 60 fps |
| Move a 1,000-object selection | 60 fps |
| Open a 100k-object document | under 3 s |

Mechanisms, introduced as profiling demands:
1. culling;
2. a per-node cached `Path2D`;
3. a bitmap cache for unchanged regions during interaction (tiles);
4. OffscreenCanvas rendering in a worker.

**Effects** (blur, shadow) render to cached offscreen bitmaps keyed by node
and resolution.

### 3.7 Editor, tools, selection and interaction (`packages/editor`)

```ts
interface EditorSession {             // one per document tab
  readonly document: DocumentStore;   // state + apply + change events
  readonly history: History;
  readonly selection: SelectionModel; // ids + derived transform box
  readonly viewport: Viewport;
  readonly tools: ToolManager;        // active tool, temporary overrides
  readonly commands: CommandRegistry;
  subscribe<T>(selector: (s: EditorSnapshot) => T, cb: (v: T) => void): Unsubscribe;
}

interface Tool {
  readonly id: ToolId; readonly cursor: CursorSpec;
  activate(ctx: ToolContext): void; deactivate(): void;
  onInput(e: InputEvent): void;       // state machine inside
  onKey(e: KeyEvent): boolean;
  drawOverlay(o: OverlayPainter): void;
}
```

- **Selection** supports click, shift-toggle, marquee (touching or enclosing),
  select-inside-group (double-click enters a group) and select-all/none. It
  derives the transform box: axis-aligned, or rotated when a single rotated
  object is selected.
- **Transforms** cover move, scale from any handle (Shift keeps proportions,
  Alt scales from centre), rotate around a movable pivot, skew, flip, align
  and distribute, arrow-key nudge with a configurable step, and numeric
  entry in the inspector. All of them are operations on `transform` or on
  shape parameters.
- **Snapping** is one service with pluggable sources: grid, guides, object
  bounds/centres/nodes, artboard edges, angle constraints. It returns the
  snapped point plus guide geometry for the overlay.
- **Clipboard** uses a native-format fragment internally. On the system
  clipboard it also writes SVG and PNG so other applications can paste.
- **Tool set by phase:**

  | Phase | Tools |
  | --- | --- |
  | 3 | Select, Rectangle, Ellipse, Polygon/Star, Hand, Zoom |
  | 4 | Node edit, Pen, Pencil, Line |
  | 6 | Gradient, Eyedropper |
  | 9 | Text |

### 3.8 Import/export adapters (`packages/io-*`)

```ts
interface Importer {
  readonly id: string; readonly extensions: readonly string[];
  sniff(head: Uint8Array): 'yes' | 'maybe' | 'no';
  import(bytes: Uint8Array, opts: ImportOptions): Promise<ImportResult>;
}
interface ImportResult {
  document: DocumentState;
  report: { source: SourceInfo;                 // e.g. { product:'CorelDRAW X5', version:1500 }
            support: 'verified' | 'experimental';
            warnings: ImportWarning[] };        // { code, message, count, nodeIds? }
}
interface Exporter { readonly id: string; export(doc: DocumentState, opts: ExportOptions): Promise<Uint8Array>; }
```

| Adapter | Plan | Honesty rule |
| --- | --- | --- |
| **CDR import** | Today's reader plus a converter to the native model: unit/axis/order conversion; rectangles and ellipses become live shapes; fills, outlines and inherited styles are applied; the invert lens becomes white fill with `difference` blend, with a report warning. | `support: 'verified'` **only** for versions with real fixtures in CI (today: 1500/X5). Everything else is `'experimental'`, and the UI says so. |
| **SVG export** | From the display list; optional "presentation attributes only" mode for compatibility. | Lists features approximated (e.g. effects without an SVG equivalent). |
| **SVG import** | A defined subset: shapes, paths, `g`, `use`, transforms, presentation attributes, inline `style` declarations for those properties, linear/radial gradients, opacity. Its own small XML parser, so it runs in workers and tests. | Unsupported features (filters, CSS selectors, text in v1) are reported, never silently dropped. |
| **PNG export** | `canvas2d` backend at chosen DPI with transparent or white background. | — |
| **PDF export** | Our own writer: paths, fills, strokes, dashes, opacity and blend via ExtGState, gradients as shadings, images; later text with embedded subset fonts. Validated by parsing and rasterising in CI. | — |
| **PDF import** | Later, via pdf.js operator lists (spike first). | Experimental. |

### 3.9 Persistence (`packages/format-native`, `apps/desktop/main`)

```
drawing.drawx  (ZIP)
├─ mimetype                 "application/x-drawx" (stored, first entry)
├─ manifest.json            { formatVersion: 1, minReaderVersion: 1, app: "Draw 0.x",
│                             created, modified, documentId }
├─ document.json            normalized node table, artboards, metadata
├─ resources/               images/*, fonts/* (only if embedding is allowed), swatches.json
└─ previews/thumbnail.png   for OS previews and the open dialog
```

**Versioning:**
- `formatVersion` increases on any schema change.
- `migrations[n]` upgrades n to n+1 as a pure function. Every historical
  version keeps a golden file in `testkit`, migrated and validated in CI.
- A file whose `minReaderVersion` is newer than the app is refused with a
  clear message.
- Unknown resource files are preserved on save.

**Writes and recovery:**
- **Atomic save:** write to a temporary file in the same directory, `fsync`,
  rename. A crash mid-save never corrupts the previous file.
- **Autosave and crash recovery:** periodic snapshots plus a journal of
  committed transactions in the app data directory. On launch, unrecovered
  sessions are offered for restore.

**Validation on load:** hand-written schema validators (no runtime
dependency), size limits, and finite-number checks.

### 3.10 Desktop workspace (UI shell)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Menu bar (native)                                                            │
├──────────────────────────────────────────────────────────────────────────────┤
│ Context bar: properties of the active tool / selection (x, y, w, h, rotation)│
├──────────────────────────────────────────────────────────────────────────────┤
│ Tabs:  [ poster.drawx ● ] [ logo.drawx ] [ import.cdr (experimental) ]       │
├────┬───────────────────────────────────────────────────────┬─────────────────┤
│ T  │                                                       │ Properties      │
│ o  │               canvas (artboards on an                 │  fill / stroke  │
│ o  │               unbounded pasteboard)                   │  appearance     │
│ l  │                                                       ├─────────────────┤
│ s  │                                                       │ Layers &        │
│    │                                                       │ objects tree    │
├────┴───────────────────────────────────────────────────────┴─────────────────┤
│ Status: zoom ▾ · cursor x/y · units ▾ · selection summary · snapping toggles │
└──────────────────────────────────────────────────────────────────────────────┘
```

- The layout is fixed in v1. Panels collapse and resize but do not dock;
  dockable panels are a later, separate decision.
- Each tab owns an `EditorSession`. One canvas host re-binds to the active
  session.
- Visual identity, iconography and naming are our own. Familiar conventions
  (tool positions, common shortcuts) are fine; replicating another product's
  look is not.

### 3.11 Proposed folder structure

```
draw/
├─ apps/
│  └─ desktop/
│     ├─ src/
│     │  ├─ main/          # Electron main: app.ts, windows.ts, menu.ts, files.ts (atomic I/O),
│     │  │                 #   autosave.ts, recovery.ts, ipc/ (handlers, validation)
│     │  ├─ preload/       # contextBridge → DesktopApi (typed, minimal)
│     │  ├─ shared/        # IPC contract types shared by main/preload/renderer
│     │  ├─ renderer/
│     │  │  ├─ workspace/  # layout, tabs, canvas host, status bar
│     │  │  ├─ toolbars/   # tool palette, context bar
│     │  │  ├─ panels/     # properties, layers, (history, swatches later)
│     │  │  ├─ dialogs/    # new document, export, import report, preferences
│     │  │  ├─ design/     # in-house UI components, theme tokens
│     │  │  └─ platform/   # DesktopApi implementations: electron, browser-dev, test fake
│     │  └─ workers/       # io.worker.ts (import/export entry points)
│     ├─ e2e/              # Playwright Electron tests + golden screenshots
│     └─ electron-builder.yml
├─ packages/
│  ├─ geometry/            # src/, test/: no dependencies
│  ├─ color/
│  ├─ document/            # model/, ops/, history/, schema/, migrations/, serialize/
│  ├─ archive/             # zip read/write, inflate, binary reader (from today's src/)
│  ├─ format-native/
│  ├─ render/              # scene/, display-list/, spatial/, viewport/, backends/{canvas2d,svg,pdf}/
│  ├─ editor/              # session/, selection/, input/, tools/<tool>/, snapping/, commands/, keymap/
│  ├─ io-cdr/              # reader (today's riff.js, cdr.js) + to-document.ts adapter
│  ├─ io-svg/
│  ├─ io-pdf/
│  ├─ io-raster/
│  └─ testkit/             # factories, seeded RNG, golden helpers, cdr builders (today's build.js)
├─ tools/                  # cdr2svg (dev CLI), fetch-fixtures.sh, check-boundaries.ts, bench/
├─ docs/
│  ├─ architecture/        # this proposal, adr/NNNN-*.md
│  └─ formats/             # cdr-format.md, rea-analysis.md, drawx-format.md
├─ tsconfig.base.json      # strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes
└─ package.json            # npm workspaces; scripts: check, test, e2e, bench, dev, package
```

---

## 4. Development roadmap

**Principles:**
- Every phase ends with a working, runnable build on the main branch.
  Incomplete tools hide behind feature flags.
- Phases can be tested on their own: everything below `apps/` is tested
  headless.
- Sizes are rough, for one experienced engineer: S ≈ 1–2 weeks, M ≈ 3–5,
  L ≈ 6–10, XL > 10. They are for sequencing, not commitments.

```
P0 Foundation ─► P1 Core model ─► P2 Desktop shell + render ─► P3 Editing MVP ─► P4 Paths
   (S–M)            (M–L)            (M)   ★ app runs             (L) ★ usable      (L)
                                                                     │
                       P5 Interop I (CDR·SVG·PNG) ◄──────────────────┤  (M)
                       P6 Appearance & effects ◄─────────────────────┤  (M–L)
                       P7 PDF export & print ◄───────────────────────┘  (M)
                       P8 Booleans & advanced geometry  (L, spike first)
                       P9 Text                          (XL, spike first)
                       P10 Scale, release engineering   (continuous from P2)
```

### P0: Foundation and lossless migration (S–M)

- **Deliverables:**
  - npm-workspaces monorepo.
  - `tsconfig.base.json` in strict mode; lint and format setup.
  - A dependency-boundary check script.
  - CI on Linux/Windows/macOS: typecheck, lint, unit tests, build.
  - Today's `src/` ported to TypeScript as `archive` + `io-cdr` + `testkit`
    with **no behaviour change**; `cdr2svg` moved to `tools/`.
  - The ADR template plus ADRs for the decisions accepted from this proposal.
- **Depends on:**
  - GitHub access, so the existing commit and CI can land.
  - Licence choice.
  - UI framework confirmation.
- **Acceptance:**
  - `npm run check` is green on all three OSes.
  - SVG output for the X5 fixture is byte-identical before and after the port
    (golden file).
  - All 18 existing tests are ported and passing.
- **Tests:** ported suite; golden-file test; boundary-check test.
- **Risks:** subtle regressions while porting, mitigated by golden files; CI
  secrets/signing not yet available, which is fine until P10.

### P1: Geometry and document core, headless (M–L)

- **Deliverables:**
  - `geometry`: primitives, Bézier maths with tight bounds, hit testing,
    flattening, arcs, shapes to paths.
  - `document` schema v1 (artboards, layers, groups, path/rect/ellipse/polygon
    nodes, solid fills, strokes, opacity, blend mode).
  - Ids; primitive operations with inverses; transactions; history
    (coalescing, dirty tracking); change sets; invariant checker.
  - JSON serialisation; validation; migration framework.
  - `archive` gains a ZIP writer; `format-native` read/write.
- **Depends on:** P0.
- **Acceptance:**
  - Property test: 10,000 random operation sequences. Undo-all equals the
    initial document, redo-all equals the final one, and invariants hold
    after every step.
  - Serialise → parse is the identity.
  - Malformed files return errors, never throw uncaught or hang (fuzzed
    corpus).
  - Geometry matches analytic results within 1e-9 relative error.
  - Benchmark: one `set` on a 100k-node document takes under 1 ms.
- **Tests:** unit, property-based (seeded), fuzz, migration golden files,
  micro-benchmarks.
- **Risks:** this is the most expensive place to get the design wrong.
  Mitigate with a schema review gate before P2, and keep `document` small
  and boring.

### P2: Desktop shell and rendering MVP, ★ the app runs (M)

- **Deliverables:**
  - Electron app with secure defaults and a typed `DesktopApi`.
  - The workspace skeleton from §3.10, with panels still minimal.
  - Document tabs.
  - New, open, save, save-as for `.drawx`, with atomic saves and close
    prompts for unsaved work.
  - Native menus generated from the command registry; undo/redo and
    shortcuts wired.
  - Render engine: scene cache, display list, Canvas 2D backend, overlay
    canvas.
  - Viewport: zoom/pan with wheel, pinch, space-drag and zoom commands.
  - Artboards on an unbounded pasteboard.
  - A read-only layers tree.
  - Packaging spike: unsigned installers for all three OSes.
- **Depends on:** P1.
- **Acceptance:**
  - Installers launch on three OSes.
  - A fixture `.drawx` renders within golden tolerance on all three.
  - Pan/zoom stays at 60 fps on a 10k-object benchmark document on reference
    hardware.
  - E2E test: launch → new document → save → close → reopen gives an
    identical document.
- **Tests:** Playwright Electron E2E; display-list snapshot tests (headless);
  raster golden images (Chromium); viewport maths unit tests.
- **Risks:**
  - Packaging and notarisation friction.
  - Deep-zoom precision (handled per §3.6).
  - Playwright's Electron API is labelled experimental; pin versions.

### P3: Core editing MVP, ★ a usable vector editor (L)

- **Deliverables:**
  - Input pipeline and tool framework.
  - Tools: Select (pick, marquee, move, scale, rotate, nudge), Rectangle
    (with corner radii), Ellipse (arc/pie), Polygon/Star, Hand, Zoom.
  - Commands: delete, duplicate, copy/paste (internal plus SVG/PNG on the
    system clipboard), group/ungroup, z-order, align/distribute, lock/hide.
  - Properties inspector: geometry fields, fill colour, stroke colour/width,
    opacity.
  - Context bar.
  - Layers panel: create, rename, reorder, hide, lock, hierarchy, selection
    sync.
  - Grid and object snapping.
  - Basic autosave and crash recovery.
  - Customisable key map.
- **Depends on:** P2.
- **Acceptance:**
  - Every command and tool edit is undoable and redoable. An automated test
    enumerates the command registry and asserts this.
  - Scripted E2E: draw, group, transform, recolour, undo to empty; the
    document equals the initial one.
  - No write bypasses transactions: types and lint forbid it, and an
    architecture test checks it.
  - Killing the app mid-edit restores the session on next launch.
- **Tests:**
  - Headless tool tests (synthetic input sequences → expected document).
  - E2E scenarios.
  - History property tests extended with tool-generated operations.
- **Risks:**
  - Interaction feel (hit tolerances, handle sizes, transform maths on
    rotated multi-selections) needs iteration with real users.
  - Inspector update cost on large selections.

### P4: Path editing (L)

- **Deliverables:**
  - Pen tool (lines, curves, close, continue).
  - Node tool: select and move nodes and handles; add and delete nodes;
    corner/smooth/symmetric; break and join.
  - Convert to curves.
  - Pencil with curve fitting.
  - Path commands: reverse, close/open, join, break apart, combine into a
    compound path with fill rule.
  - Point and angle snapping; smart guides.
- **Depends on:** P3.
- **Acceptance:**
  - A pen scenario yields exact expected nodes.
  - Curve-fit error stays within tolerance across a recorded-stroke corpus.
  - Compound-path fill rules render and hit-test identically.
- **Tests:** geometry property tests (split/join identity, reverse twice =
  identity); tool tests; E2E.
- **Risks:** UX depth; robustness of joining near-coincident endpoints.

### P5: Interoperability I (M)

- **Deliverables:**
  - Adapter framework in a worker, with an import-report dialog.
  - CDR import through the native-model converter, with an "experimental"
    badge, the X5 label and a feature report.
  - SVG export.
  - SVG import (subset per §3.8).
  - PNG export.
  - Drag-and-drop and OS "open with".
- **Depends on:** P3. P4 is preferred so imported paths are fully editable.
- **Acceptance:**
  - The X5 fixture imports with 5 live rectangles, palette-exact colours and
    style outlines. Its render matches CorelDRAW's embedded thumbnail within
    today's measured threshold (mean absolute difference ≤ 8.1/255 at
    181×256).
  - SVG export → import round-trip preserves geometry within 1e-6 pt.
  - A curated subset of the W3C SVG test suite passes.
  - Fuzzed CDR and SVG inputs never crash the app or exceed memory limits.
- **Tests:** fixture tests, round-trip property tests, fuzzing, E2E import.
- **Risks:**
  - SVG's breadth: scope it explicitly.
  - CDR sample scarcity: acquire more legitimately licensed samples.
    Version claims grow only with fixtures.

### P6: Appearance and effects (M–L)

- **Deliverables:**
  - Linear and radial gradients with an on-canvas gradient tool.
  - Multiple fills and strokes per object (appearance stack).
  - Dashes, caps, joins, miter limit, arrowheads.
  - Blend modes and opacity.
  - Effects: drop shadow, Gaussian blur, with cached rendering.
  - Swatches and global colours.
  - Colour picker (RGB/HSB/CMYK as device values) and eyedropper.
- **Depends on:** P3 (P5 for SVG round-trip of the new features).
- **Acceptance:**
  - Raster golden images per feature.
  - Exporters report anything they approximate.
  - Effects keep the P2 frame-rate budget during pan on the benchmark
    document.
- **Risks:**
  - Effect performance.
  - Print users expecting true CMYK/ICC, deferred explicitly to a
    colour-management phase.

### P7: PDF export and print (M)

- **Deliverables:**
  - PDF writer (vector, multi-artboard, shadings, ExtGState, images).
  - Print via the system dialog.
- **Depends on:** P6 (feature parity of the display list).
- **Acceptance:**
  - Generated PDFs pass a structural validator in CI.
  - pdf.js rasterisation of the export matches the app render within
    tolerance.
- **Risks:** mapping effects and blend modes to PDF; colour spaces.

### P8: Boolean operations and advanced geometry (L, high risk)

- **Spike first (M)** with a shared corpus (coincident edges, tangencies,
  self-intersections, holes). Candidates:
  - (a) an exact Bézier Boolean algorithm implemented in-house;
  - (b) flatten → robust polygon clipper → curve refit;
  - (c) CanvasKit PathOps.

  The spike measures robustness, accuracy and speed, and closes with an ADR.
- **Deliverables:** union, subtract, intersect, exclude, divide; offset
  path; outline stroke; simplify.
- **Acceptance:** zero failures on the corpus; results are valid closed
  paths; performance within budget on 1,000-segment inputs.
- **Risks:** numeric robustness. This is historically the hardest geometry
  feature in vector editors.

### P9: Text (XL, high risk)

- **Spike first (M):**
  - Font enumeration (Chromium Local Font Access vs main-process scanning).
  - Shaping with HarfBuzz WASM.
  - Glyph outlines.
  - Licence review of fonts for embedding.
- **Deliverables:**
  - Point/artistic text, then paragraph text: line breaking, alignment,
    basic OpenType features, bidi later.
  - Text-to-curves.
  - SVG/PDF text export with subset embedding.
- **Acceptance:** shaping matches HarfBuzz reference output for a
  multi-script corpus; text renders identically on three OSes; round-trips
  through `.drawx`.
- **Risks:** the largest subsystem; font licensing; performance of live
  re-layout.

### P10: Scale and release engineering (continuous, from P2)

- **Scale:**
  - R-tree culling and hit testing.
  - Tile/bitmap caching during interaction.
  - Worker rendering.
  - The 100k-object target.
- **Release engineering:**
  - Code signing and notarisation.
  - Auto-update channels.
  - File associations and OS thumbnails.
  - Opt-in crash reporting.
  - Accessibility (keyboard-operable panels, screen-reader labels).
  - Localisation scaffolding.
- **Parallel interop track:**
  - More CDR coverage as legitimately obtained samples arrive. Each new
    version is promoted to "verified" only with a CI fixture.
  - PDF import spike.

### Cross-phase test strategy

| Layer | Kind | Runs |
| --- | --- | --- |
| `geometry`, `color` | Unit + property tests (seeded RNG) | Every commit, headless |
| `document` | Operation/inverse property tests, invariants, serialisation round-trips, migration golden files, fuzzing | Every commit |
| `render` | Display-list snapshot tests (headless) + Chromium raster golden images | Every commit / every PR |
| `editor` | Tool state-machine tests with synthetic input; command-registry undo audit | Every commit |
| `io-*` | Real-file fixtures (fetched with hash pinning), round-trips, fuzzing with mutated fixtures | Every PR; nightly fuzzing |
| `apps/desktop` | Playwright Electron E2E on Linux (xvfb), Windows, macOS | Every PR (smoke), nightly (full) |
| Performance | Benchmarks with thresholds and trend tracking | Nightly; non-blocking until P10 |

---

## 5. Risk register (top items)

| Risk | Impact | Likelihood | Mitigation |
| --- | --- | --- | --- |
| Document schema needs breaking changes after users have files | High | Medium | Review gate after P1; migration framework from day one; golden files for every version |
| Interaction quality falls short of professional tools | High | Medium | Early P3 usability sessions; keep tool logic headless-testable so tuning is cheap |
| Boolean operations are not robust | High | High | Spike plus corpus before committing; keep behind an interface; fall back to a proven clipper |
| Text engine scope explodes | High | High | Late phase; spike; artistic text before paragraph text; adopt HarfBuzz rather than write a shaper |
| Rendering performance at 100k objects | Medium | Medium | Display-list and cache architecture from P2; benchmarks in CI; GPU backend as a contingency |
| Electron upgrade churn and security patches | Medium | High | Upgrade every second major; automated E2E; minimal main-process surface |
| CDR expectations exceed evidence (only X5 verified) | Medium | High | `verified`/`experimental` labels in code and UI; acquire licensed samples; no claims without fixtures |
| Legal and IP | High | Low | No proprietary code or assets. Independent visual design. Third-party references (libcdr, MPL-2.0) used for facts only. Licence audit for every dependency (ADR). |

---

## 6. What happens to the existing CDR work

Nothing is discarded:

| Today | Becomes |
| --- | --- |
| `binary.js`, `inflate.js`, `zip.js` | `packages/archive` (also used by the native format) |
| `riff.js`, `cdr.js` | `packages/io-cdr/reader`, unchanged in behaviour |
| — | `packages/io-cdr/to-document.ts`, the new adapter to the native model |
| `color.js` | conversion helpers inside `packages/color` |
| `path.js` | seed of `packages/geometry` |
| `build.js` | `packages/testkit/cdr` |
| `svg.js`, `bin/cdr2svg.js`, `web/` | developer tools and golden references until the SVG exporter and desktop import replace them |
| `docs/cdr-format.md`, `docs/rea-analysis.md` | `docs/formats/` |

---

## 7. Decisions needed before P0

1. **Licence** for the project. Proprietary or open source; this affects
   which dependencies are acceptable.
2. **Electron** as the shell (recommended), or a requirement that forces
   Tauri.
3. **UI framework:** React (recommended), Preact or Solid.
4. **Artboard model:** multiple artboards in one world (recommended), or
   CorelDRAW-style pages viewed one at a time.
5. **Product name and file extension** (`.drawx` is a placeholder).
6. **Priority of print and CMYK fidelity** relative to screen and SVG
   workflows. This decides when colour management (ICC) is scheduled.
7. **Target platforms and minimum OS versions** for the first release.
8. **GitHub access** for this session, so the existing commit `d203482` and
   this proposal can be pushed and CI can start.

---

## Sources consulted for the technology evaluation

- [Tauri: Linux graphics issues (official docs)](https://v2.tauri.app/develop/debug/linux-graphics/)
- [tauri-runtime-cef on docs.rs (community CEF runtime, alpha)](https://docs.rs/crate/tauri-runtime-cef/3.0.0-alpha.5)
- [SableClient/tauri-runtime-cef (repository README)](https://github.com/SableClient/tauri-runtime-cef)
- [Electron release timelines](https://electronjs.org/de/docs/latest/tutorial/electron-timelines)
- [WebGPU (overview and browser status)](https://en.wikipedia.org/wiki/WebGPU)
- [gpuweb implementation status](https://github.com/gpuweb/gpuweb/wiki/implementation-status)
