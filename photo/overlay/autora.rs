//! Autora's side of the PhotoCraft window (copied into apps/photocraft-web/src/ by scripts/build-photo.mjs).
//!
//! PhotoCraft runs in a frame of Autora's page (components/PhotoWindow.tsx), and the two talk by postMessage only. All
//! of it is inert when the page is not framed, so the same build still works on its own.
//!
//! Page -> editor:
//!   { autoraPhoto: "load", name, bytes }   the working picture, as a .pcraft: it replaces what is open
//!
//! Editor -> page:
//!   { autoraPhoto: "ready" }               the editor is up and listening
//!   { autoraPhoto: "changed", name, bytes } the person changed the picture (a .pcraft, after a pause in their edits)
//!   { autoraPhoto: "file", name, bytes }   the person saved or exported a file (File > Save, Export): the page offers it
//!                                          as a download, since a frame cannot start one the way a page can
//!
//! The picture that is synced is the active document, so what the agent works on is what the person is looking at.

use std::cell::RefCell;
use std::time::Duration;

use js_sys::{ArrayBuffer, Object, Reflect, Uint8Array};
use photocraft_doc::DocId;
use photocraft_io::ExportOptions;
use photocraft_ui_egui::{Inbox, PhotocraftApp};
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

const NS: &str = "autoraPhoto";
/// The name the synced picture goes under; the page keeps one working file per chat.
const WORK_NAME: &str = "work.pcraft";
/// How long the picture must sit unchanged before it is sent: a brush stroke is many revisions, one send.
const QUIET_MS: f64 = 700.0;

struct Pending {
    name: String,
    bytes: Vec<u8>,
}

#[derive(Default)]
struct Bridge {
    /// Loads that arrived and are not yet opened.
    loads: Vec<Pending>,
    /// The document and revision last sent, or that the page loaded: nothing to send until it moves on.
    sent: Option<(DocId, u64)>,
    /// The revision seen on the previous frame, and when it first showed.
    seen: Option<((DocId, u64), f64)>,
}

thread_local! {
    static SYNC: RefCell<Bridge> = RefCell::new(Bridge::default());
}

fn window() -> Option<web_sys::Window> {
    web_sys::window()
}

/// The page that frames this one, or None when this page stands alone.
fn parent() -> Option<web_sys::Window> {
    let me = window()?;
    let up = me.parent().ok().flatten()?;
    let (a, b): (&JsValue, &JsValue) = (up.as_ref(), me.as_ref());
    if a == b { None } else { Some(up) }
}

/// Whether Autora's page is around this one.
pub fn framed() -> bool {
    parent().is_some()
}

fn send(kind: &str, name: Option<&str>, bytes: Option<&[u8]>) -> Result<(), String> {
    let js = |e: JsValue| format!("{e:?}");
    let up = parent().ok_or("not framed")?;
    let origin = window().ok_or("no window")?.location().origin().map_err(js)?;
    let msg = Object::new();
    Reflect::set(&msg, &NS.into(), &kind.into()).map_err(js)?;
    if let Some(name) = name {
        Reflect::set(&msg, &"name".into(), &name.into()).map_err(js)?;
    }
    if let Some(bytes) = bytes {
        Reflect::set(&msg, &"bytes".into(), &Uint8Array::from(bytes).buffer()).map_err(js)?;
    }
    up.post_message(&msg, &origin).map_err(js)
}

/// A file the person saved or exported, handed to the page.
pub fn file(path: &str, bytes: &[u8]) -> Result<(), String> {
    let name = std::path::Path::new(path).file_name().map_or_else(|| path.to_owned(), |n| n.to_string_lossy().to_string());
    send("file", Some(&name), Some(bytes))
}

/// Listen for the page, and say the editor is up. Called once, when the app is made.
pub fn start(ctx: &egui::Context) {
    let (Some(me), true) = (window(), framed()) else { return };
    let ctx = ctx.clone();
    let on_message = Closure::<dyn FnMut(JsValue)>::new(move |ev: JsValue| {
        let Some(me) = window() else { return };
        // Only the page that frames this one, and only from its own origin.
        let origin = Reflect::get(&ev, &"origin".into()).ok().and_then(|v| v.as_string());
        let same = me.location().origin().ok();
        let source = Reflect::get(&ev, &"source".into()).ok();
        let from_parent = match (me.parent().ok().flatten(), source) {
            (Some(p), Some(s)) => AsRef::<JsValue>::as_ref(&p) == &s,
            _ => false,
        };
        if !from_parent || origin.is_none() || origin != same {
            return;
        }
        let Ok(data) = Reflect::get(&ev, &"data".into()) else { return };
        if !data.is_object() || Reflect::get(&data, &NS.into()).ok().and_then(|v| v.as_string()).as_deref() != Some("load") {
            return;
        }
        let name = Reflect::get(&data, &"name".into()).ok().and_then(|v| v.as_string()).unwrap_or_else(|| WORK_NAME.into());
        let Ok(buffer) = Reflect::get(&data, &"bytes".into()).and_then(|b| b.dyn_into::<ArrayBuffer>()) else { return };
        let bytes = Uint8Array::new(&buffer).to_vec();
        SYNC.with(|s| s.borrow_mut().loads.push(Pending { name, bytes }));
        ctx.request_repaint();
    });
    me.add_event_listener_with_callback("message", on_message.as_ref().unchecked_ref()).ok();
    on_message.forget();
    send("ready", None, None).ok();
}

/// Every frame, before the app runs: open what the page sent, in place of what is open.
pub fn pump(app: &mut PhotocraftApp, inbox: &Inbox) {
    if phone_on() {
        phone_pump(app);
    }
    let loads = SYNC.with(|s| std::mem::take(&mut s.borrow_mut().loads));
    // Only the newest matters: a quick run of agent edits is one picture.
    let Some(load) = loads.into_iter().last() else { return };
    while !app.session.documents().is_empty() {
        app.session.close(0);
    }
    inbox.lock().unwrap_or_else(|e| e.into_inner()).push((load.name, load.bytes));
    SYNC.with(|s| {
        let mut s = s.borrow_mut();
        s.sent = None;
        s.seen = None;
    });
}

/// Every frame, after the app ran: when the person's picture has changed and then held still, send it.
pub fn tick(app: &PhotocraftApp, ctx: &egui::Context) {
    if !framed() {
        return;
    }
    if phone_on() {
        phone_bar(app, ctx);
    }
    let now = js_sys::Date::now();
    let Some(st) = app.session.active() else { return };
    let key = (st.doc.id, st.revision);
    let dirty = st.is_dirty();
    let due = SYNC.with(|s| {
        let mut s = s.borrow_mut();
        // Clean means as opened (or as the page sent it): nothing the person did.
        if !dirty || s.sent == Some(key) {
            s.seen = None;
            return false;
        }
        match s.seen {
            Some((seen, since)) if seen == key => now - since >= QUIET_MS,
            _ => {
                s.seen = Some((key, now));
                false
            }
        }
    });
    if !due {
        if dirty && SYNC.with(|s| s.borrow().sent != Some(key)) {
            ctx.request_repaint_after(Duration::from_millis(250));
        }
        return;
    }
    match photocraft_io::export(&st.doc, WORK_NAME, &ExportOptions::default()) {
        Ok(done) => {
            if send("changed", Some(WORK_NAME), Some(&done.bytes)).is_ok() {
                SYNC.with(|s| s.borrow_mut().sent = Some(key));
            }
        }
        Err(e) => log::error!("autora: could not keep the picture: {e}"),
    }
}

// ---- the phone's editor ------------------------------------------------------------------------------------------
//
// PhotoCraft is a Photoshop-sized editor (fifty-two tools, a dozen panels, menus). On a phone, in Autora's window
// (components/PhotoWindow.tsx adds `?phone=1` to the frame's address), it is paired down to what a thumb does well and
// the rest is left to the agent, which has every tool wherever the picture is shown: a bar at the bottom (undo, redo,
// Tools, Brush, Layers, Fit) over the picture alone. The menu bar, the toolbox, the options bar, the status bar and the
// panel dock are away. Tools, Brush and Layers open one sheet each: nine tools in a grid, the brush's size, strength and
// colour, and the layers (an eye, a name, new, delete, and how strong the chosen one is). Nothing else about the editor changes, and a desktop
// never runs any of this.
//
// The bar is drawn after the app each frame (`tick`, which can only look at the app) and what it asks for is queued;
// the next frame's `pump` (which has the app) does it, through the editor's own commands.

use photocraft_ui_egui::Tool;

/// What a tap on the bar asks for.
enum Ask {
    Undo,
    Redo,
    Fit,
    Tool(Tool),
    Sheet(Option<Sheet>),
    /// One of the editor's own commands, with its parameters.
    Command(&'static str, serde_json::Value),
    Brush { size: Option<f32>, opacity: Option<f32> },
    Colour([f32; 4]),
}

#[derive(Clone, Copy, PartialEq)]
enum Sheet {
    Tools,
    Brush,
    Layers,
}

#[derive(Default)]
struct Phone {
    on: Option<bool>,
    asks: Vec<Ask>,
    sheet: Option<Sheet>,
    ctx: Option<egui::Context>,
}

thread_local! {
    static PHONE: RefCell<Phone> = RefCell::new(Phone::default());
}

/// Whether the page asked for the phone's editor (`?phone=1`): read once.
fn phone_on() -> bool {
    PHONE.with(|p| {
        let mut p = p.borrow_mut();
        *p.on.get_or_insert_with(|| {
            framed() && window().and_then(|w| w.location().search().ok()).is_some_and(|q| q.split(['?', '&']).any(|kv| kv == "phone=1"))
        })
    })
}

/// The nine tools of the sheet, in the order a person reaches for them.
const TOOLS: [(&str, Tool); 9] = [
    ("Move", Tool::Move),
    ("Select", Tool::RectMarquee),
    ("Brush", Tool::Brush),
    ("Eraser", Tool::Eraser),
    ("Text", Tool::Type),
    ("Crop", Tool::Crop),
    ("Fill", Tool::PaintBucket),
    ("Pick colour", Tool::Eyedropper),
    ("Pan", Tool::Hand),
];

fn painting(tool: Tool) -> bool {
    matches!(tool, Tool::Brush | Tool::Pencil | Tool::Eraser | Tool::PaintBucket)
}

/// Before the app runs: do what the bar asked for, and keep the chrome the phone's.
fn phone_pump(app: &mut PhotocraftApp) {
    let (asks, ctx) = PHONE.with(|p| {
        let mut p = p.borrow_mut();
        (std::mem::take(&mut p.asks), p.ctx.clone())
    });
    for ask in asks {
        let Some(ctx) = ctx.as_ref() else { break };
        let none = || serde_json::json!({});
        match ask {
            Ask::Undo => drop(photocraft_ui_egui::menus::invoke(app, ctx, "edit.undo", none())),
            Ask::Redo => drop(photocraft_ui_egui::menus::invoke(app, ctx, "edit.redo", none())),
            Ask::Fit => drop(photocraft_ui_egui::menus::invoke(app, ctx, "view.fitOnScreen", none())),
            Ask::Command(id, params) => drop(photocraft_ui_egui::menus::invoke(app, ctx, id, params)),
            Ask::Tool(t) => {
                app.ui.tool = t;
                PHONE.with(|p| p.borrow_mut().sheet = None);
            }
            Ask::Sheet(s) => PHONE.with(|p| p.borrow_mut().sheet = s),
            Ask::Brush { size, opacity } => {
                if let Some(s) = size {
                    app.session.tools.brush.size = s;
                }
                if let Some(o) = opacity {
                    app.session.tools.brush.opacity = o;
                }
            }
            Ask::Colour(c) => app.session.tools.foreground = c,
        }
    }
    // The picture alone: everything else is a sheet over it.
    app.ui.view.screen_mode = "fullScreen".into();
}

/// How many of the editor's points are one CSS pixel of the frame. Usually 1 (or the device's ratio); inside some
/// phone browsers the canvas is drawn at half the page's resolution and a point is two CSS pixels: sizes are asked for in CSS
/// pixels, so the bar is the same size to a thumb either way.
fn per_css_px(ctx: &egui::Context) -> f32 {
    let inner = window().and_then(|w| w.inner_width().ok()).and_then(|v| v.as_f64()).unwrap_or(0.0) as f32;
    if inner > 1.0 { ctx.content_rect().width() / inner } else { 1.0 }
}

fn soft(ui: &mut egui::Ui, text: &str, on: bool, w: f32, k: f32) -> egui::Response {
    let (fill, ink) = if on {
        (egui::Color32::from_rgba_unmultiplied(110, 91, 255, 54), egui::Color32::from_rgb(237, 239, 245))
    } else {
        (egui::Color32::from_rgb(21, 24, 36), egui::Color32::from_rgb(152, 161, 182))
    };
    // egui's own minimum for a button (40 points wide) is bigger than a sixth of this bar: it is asked for smaller.
    ui.spacing_mut().interact_size = egui::vec2(4.0 * k, 4.0 * k);
    ui.spacing_mut().button_padding = egui::vec2(2.0 * k, 2.0 * k);
    ui.add_sized([w, 40.0 * k], egui::Button::new(egui::RichText::new(text).size(13.0 * k).color(ink)).min_size(egui::vec2(w, 40.0 * k)).fill(fill).corner_radius(12.0 * k))
}

/// After the app ran: the bar, and the sheet over it. Drawn over the picture, never part of it.
fn phone_bar(app: &PhotocraftApp, ctx: &egui::Context) {
    PHONE.with(|p| {
        p.borrow_mut().ctx.get_or_insert_with(|| ctx.clone());
    });
    let sheet = PHONE.with(|p| p.borrow().sheet);
    let tool = app.ui.tool;
    let (can_undo, can_redo) = app.session.active().map_or((false, false), |s| (s.history.can_undo(), s.history.can_redo()));
    let mut asks: Vec<Ask> = Vec::new();
    let screen = ctx.content_rect();
    let panel = egui::Color32::from_rgb(14, 16, 22);
    let edge = egui::Stroke::new(1.0, egui::Color32::from_white_alpha(28));
    let k = per_css_px(ctx);
    let bar_h = 56.0 * k;

    egui::Area::new(egui::Id::new("autora-phone-bar")).order(egui::Order::Foreground).fixed_pos(egui::pos2(0.0, screen.bottom() - bar_h)).show(ctx, |ui| {
        egui::Frame::NONE.fill(panel).stroke(edge).inner_margin(egui::Margin::symmetric((8.0 * k) as i8, (8.0 * k) as i8)).show(ui, |ui| {
            ui.set_width(screen.width() - 16.0 * k);
            ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = 6.0 * k;
                let w = (screen.width() - 16.0 * k - 5.0 * 6.0 * k - 2.0) / 6.0;
                if ui.add_enabled_ui(can_undo, |ui| soft(ui, "Undo", false, w, k)).inner.clicked() {
                    asks.push(Ask::Undo);
                }
                if ui.add_enabled_ui(can_redo, |ui| soft(ui, "Redo", false, w, k)).inner.clicked() {
                    asks.push(Ask::Redo);
                }
                if soft(ui, "Tools", sheet == Some(Sheet::Tools), w, k).clicked() {
                    asks.push(Ask::Sheet(if sheet == Some(Sheet::Tools) { None } else { Some(Sheet::Tools) }));
                }
                if ui.add_enabled_ui(painting(tool), |ui| soft(ui, "Brush", sheet == Some(Sheet::Brush), w, k)).inner.clicked() {
                    asks.push(Ask::Sheet(if sheet == Some(Sheet::Brush) { None } else { Some(Sheet::Brush) }));
                }
                if soft(ui, "Layers", sheet == Some(Sheet::Layers), w, k).clicked() {
                    asks.push(Ask::Sheet(if sheet == Some(Sheet::Layers) { None } else { Some(Sheet::Layers) }));
                }
                if soft(ui, "Fit", false, w, k).clicked() {
                    asks.push(Ask::Fit);
                }
            });
        });
    });

    if let Some(open) = sheet {
        egui::Area::new(egui::Id::new("autora-phone-sheet")).order(egui::Order::Foreground).anchor(egui::Align2::CENTER_BOTTOM, egui::vec2(0.0, -(bar_h + 8.0 * k))).show(ctx, |ui| {
            egui::Frame::NONE.fill(panel).stroke(edge).corner_radius(16.0 * k).inner_margin(12.0 * k).show(ui, |ui| {
                ui.set_width((screen.width() - 24.0 * k).min(360.0 * k));
                match open {
                    Sheet::Tools => {
                        ui.spacing_mut().item_spacing = egui::vec2(8.0 * k, 8.0 * k);
                        let w = ((screen.width() - 24.0 * k).min(360.0 * k) - 16.0 * k) / 3.0;
                        for row in TOOLS.chunks(3) {
                            ui.horizontal(|ui| {
                                for (name, t) in row {
                                    if soft(ui, name, tool == *t, w, k).clicked() {
                                        asks.push(Ask::Tool(*t));
                                    }
                                }
                            });
                        }
                    }
                    Sheet::Layers => {
                        let Some(st) = app.session.active() else {
                            ui.label("No picture open.");
                            return;
                        };
                        let active = st.active_layer;
                        ui.spacing_mut().item_spacing = egui::vec2(6.0 * k, 6.0 * k);
                        let full = (screen.width() - 24.0 * k).min(360.0 * k);
                        egui::ScrollArea::vertical().max_height(220.0 * k).show(ui, |ui| {
                            // Top layer first, as every editor lists them.
                            for l in st.doc.layers.iter().rev() {
                                ui.horizontal(|ui| {
                                    let eye = if l.visible { "Shown" } else { "Hidden" };
                                    if soft(ui, eye, l.visible, 64.0 * k, k).clicked() {
                                        asks.push(Ask::Command("layer.setProps", serde_json::json!({"layer": l.id.0, "visible": !l.visible})));
                                    }
                                    if soft(ui, &l.name, active == Some(l.id), full - 64.0 * k - 6.0 * k, k).clicked() {
                                        asks.push(Ask::Command("layer.select", serde_json::json!({"layer": l.id.0})));
                                    }
                                });
                            }
                        });
                        if let Some(l) = active.and_then(|id| st.doc.layer(id)) {
                            let mut pct = l.opacity * 100.0;
                            ui.spacing_mut().slider_width = full - 110.0 * k;
                            if ui.add(egui::Slider::new(&mut pct, 0.0..=100.0).text("Opacity")).changed() {
                                asks.push(Ask::Command("layer.setProps", serde_json::json!({"layer": l.id.0, "opacity": pct / 100.0})));
                            }
                        }
                        ui.horizontal(|ui| {
                            let half = (full - 6.0 * k) / 2.0;
                            if soft(ui, "New layer", false, half, k).clicked() {
                                asks.push(Ask::Command("layer.new.layer", serde_json::json!({})));
                            }
                            if soft(ui, "Delete", false, half, k).clicked() {
                                asks.push(Ask::Command("layer.delete", serde_json::json!({})));
                            }
                        });
                    }
                    Sheet::Brush => {
                        let b = &app.session.tools.brush;
                        let (mut size, mut opacity) = (b.size, b.opacity * 100.0);
                        let mut colour = app.session.tools.foreground;
                        ui.spacing_mut().slider_width = (screen.width() - 24.0 * k).min(360.0 * k) - 110.0 * k;
                        let a = ui.add(egui::Slider::new(&mut size, 1.0..=300.0).logarithmic(true).text("Size"));
                        let c = ui.add(egui::Slider::new(&mut opacity, 1.0..=100.0).text("Strength"));
                        if a.changed() || c.changed() {
                            asks.push(Ask::Brush { size: a.changed().then_some(size), opacity: c.changed().then_some(opacity / 100.0) });
                        }
                        ui.horizontal(|ui| {
                            ui.label("Colour");
                            if ui.color_edit_button_rgba_unmultiplied(&mut colour).changed() {
                                asks.push(Ask::Colour(colour));
                            }
                        });
                    }
                }
            });
        });
    }

    if !asks.is_empty() {
        PHONE.with(|p| p.borrow_mut().asks.extend(asks));
        ctx.request_repaint();
    }
}
