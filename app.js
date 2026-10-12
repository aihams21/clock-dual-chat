/* Clock Dual - chat app (Firebase Realtime Database)
   Everything lives under /clockdual so it never touches other app data.

   Message lifecycle, enforced by database.rules.json:
     send    -> create, senderId = me
     edit    -> body only, sender only, not on a tombstone
     delete  -> soft (deleted:true, body dropped), sender only, ONE-WAY
   The other side sees edits and deletions instantly via child_changed. */

const CFG = window.CONFIG || {};
if (!CFG.apiKey || !CFG.databaseURL) {
  document.body.innerHTML =
    '<div style="margin:auto;padding:24px;text-align:center;color:#8b97a8;font:15px system-ui">' +
    "لم يتم إعداد الاتصال بقاعدة البيانات بعد.</div>";
  throw new Error("config not filled");
}

const fb = firebase.initializeApp(CFG);
const auth = firebase.auth();
const db = firebase.database();

const ROOT = "clockdual";
const $ = (id) => document.getElementById(id);
const show = (id) => {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  $(id).classList.add("active");
};

let me = null;        // { uid, username, displayName }
let peer = null;
let unsubMessages = null;
let unsubInbox = null;
let sending = false;
let editingKey = null; // message id currently open in the editor

/* ---------------- helpers ---------------- */
const convoKey = (a, b) => [a, b].sort().join("__");
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

function friendly(e) {
  const m = String(e?.message || e);
  if (/auth\/invalid-credential|wrong password|user-not-found/i.test(m))
    return "الإيميل أو كلمة السر غلط";
  if (/auth\/email-already-in-use/i.test(m)) return "هذا الإيميل مسجّل قبل";
  if (/auth\/weak-password/i.test(m)) return "كلمة السر ضعيفة (6 أحرف على الأقل)";
  if (/PERMISSION_DENIED/i.test(m)) return "ما عندك صلاحية";
  if (/MAX_RULES|too many|depth exceeded/i.test(m)) return "قاعدة البيانات ممتلئة";
  if (/Failed to fetch|NetworkError|network/i.test(m)) return "ما في نت — تأكد من الاتصال";
  return m;
}

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove("show"), 2400);
}

function avatarFor(el, p) {
  const name = (p.displayName || p.username || "؟").trim();
  el.textContent = name.charAt(0).toUpperCase();
  el.style.background = "";
  if (p.avatarUrl) {
    const img = new Image();
    img.src = p.avatarUrl;
    img.onerror = () => img.remove();
    el.textContent = "";
    el.appendChild(img);
  }
}

function hhmm(ts) {
  return new Date(ts).toLocaleTimeString("ar", { hour: "2-digit", minute: "2-digit" });
}

/* ---------------- auth ---------------- */
let isRegister = false;

$("toggle-mode").onclick = () => {
  isRegister = !isRegister;
  $("auth-sub").textContent = isRegister ? "أنشئ حساب جديد" : "سجّل دخولك";
  $("auth-submit").textContent = isRegister ? "إنشاء الحساب" : "دخول";
  $("toggle-mode").textContent = isRegister ? "عندك حساب؟ سجّل دخولك" : "ما عندك حساب؟ سجّل جديد";
  $("wrap-username").classList.toggle("hidden", !isRegister);
  $("wrap-name").classList.toggle("hidden", !isRegister);
  $("auth-error").textContent = "";
};

$("auth-form").onsubmit = async (ev) => {
  ev.preventDefault();
  const email = $("email").value.trim();
  const password = $("password").value;
  const err = $("auth-error");
  err.textContent = "";

  const username = $("username").value.trim().toLowerCase();
  if (isRegister && !/^[a-z0-9_.\-]{2,24}$/.test(username)) {
    err.textContent = "اسم المستخدم: حروف إنجليزية وأرقام فقط، من 2 إلى 24";
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    err.textContent = "الإيميل مو صحيح";
    return;
  }
  if (password.length < 6) {
    err.textContent = "كلمة السر لازم 6 أحرف على الأقل";
    return;
  }

  const btn = $("auth-submit");
  btn.disabled = true;
  btn.textContent = "لحظة…";

  try {
    if (isRegister) {
      const cred = await auth.createUserWithEmailAndPassword(email, password);
      const displayName = $("displayname").value.trim() || username;
      const claimed = await db.ref(`${ROOT}/usernames/${username}`).transaction((cur) =>
        cur === null ? cred.user.uid : undefined
      );
      if (!claimed.committed) {
        await cred.user.delete();
        throw new Error("اسم المستخدم محجوز");
      }
      await db.ref(`${ROOT}/profiles/${cred.user.uid}`).set({
        username, displayName, avatarUrl: "", createdAt: Date.now(),
      });
      await cred.user.updateProfile({ displayName });
    } else {
      await auth.signInWithEmailAndPassword(email, password);
    }
  } catch (e) {
    err.textContent = friendly(e);
  } finally {
    btn.disabled = false;
    btn.textContent = isRegister ? "إنشاء الحساب" : "دخول";
  }
};

$("logout").onclick = async () => {
  teardown();
  await auth.signOut();
};

auth.onAuthStateChanged(async (user) => {
  if (!user) {
    $("auth-error").textContent = "";
    return show("auth");
  }
  const err = $("auth-error");
  try {
    // onAuthStateChanged fires the moment createUserWithEmailAndPassword resolves,
    // which is BEFORE the register handler has written the profile. Poll for it,
    // and self-heal from auth metadata if it still is not there.
    const profile = await ensureProfile(user);
    if (!profile) {
      err.textContent = "ما قدرنا نقرأ بروفايلك — أعد المحاولة";
      await auth.signOut();
      return;
    }
    me = profile;
    $("me-name").textContent = me.displayName || me.username;
    $("me-username").textContent = me.username;
    avatarFor($("me-avatar"), me);
    show("search");
    watchInbox();
    const m = location.hash.match(/^#\/u\/([\w.\-]+)$/);
    if (m) openByUsername(m[1]);
  } catch (e) {
    err.textContent = friendly(e);
    show("auth");
  }
});

async function ensureProfile(user) {
  const ref = db.ref(`${ROOT}/profiles/${user.uid}`);
  for (let attempt = 0; attempt < 25; attempt++) {
    const snap = await ref.get();
    if (snap.exists()) return { uid: user.uid, ...snap.val() };

    // only start self-healing once the register handler has had time to finish
    if (attempt === 6) {
      const meta = user.user_metadata || {};
      const username = (meta.username || (user.email || "").split("@")[0])
        .toLowerCase()
        .replace(/[^a-z0-9_.\-]/g, "")
        .slice(0, 24);
      if (username.length >= 2) {
        const claimed = await db
          .ref(`${ROOT}/usernames/${username}`)
          .transaction((cur) => (cur === null ? user.uid : undefined));
        if (claimed.committed) {
          await ref.set({
            username,
            displayName: meta.displayName || username,
            avatarUrl: "",
            createdAt: Date.now(),
          });
        }
      }
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

/* ---------------- search ---------------- */
let searchT;
$("q").oninput = (ev) => {
  const raw = ev.target.value.trim().toLowerCase();
  clearTimeout(searchT);
  const list = $("results");
  if (raw.length < 2) {
    list.innerHTML = "";
    $("search-hint").textContent = "اكتب حرفين على الأقل";
    return;
  }
  $("search-hint").textContent = "جارِ البحث…";
  searchT = setTimeout(() => runSearch(raw), 260);
};

async function runSearch(q) {
  const list = $("results");
  try {
    const snap = await db
      .ref(`${ROOT}/usernames`)
      .orderByKey()
      .startAt(q)
      .endAt(q + "￿")
      .limitToFirst(30)
      .get();

    const uids = [...new Set(Object.values(snap.val() || {}))].filter((u) => u !== me.uid);
    if (!uids.length) {
      list.innerHTML = "";
      $("search-hint").textContent = "ما لقينا حدا";
      return;
    }

    const profs = await Promise.all(uids.map((u) => db.ref(`${ROOT}/profiles/${u}`).get()));
    const people = profs
      .filter((s) => s.exists())
      .map((s) => ({ uid: s.key, ...s.val() }))
      .filter((p) => p.username.startsWith(q) || (p.displayName || "").toLowerCase().includes(q))
      .slice(0, 30);

    list.innerHTML = "";
    $("search-hint").textContent = people.length ? `${people.length} نتيجة` : "ما لقينا حدا";

    for (const p of people) {
      const li = document.createElement("li");
      const av = document.createElement("div");
      av.className = "avatar";
      avatarFor(av, p);
      const info = document.createElement("div");
      info.className = "me-info";
      const b = document.createElement("b");
      b.textContent = p.displayName || p.username;
      const sm = document.createElement("small");
      sm.textContent = "@" + p.username;
      info.append(b, sm);
      li.append(av, info);
      li.onclick = () => openChat(p);
      list.appendChild(li);
    }
  } catch (e) {
    $("search-hint").textContent = friendly(e);
  }
}

async function openByUsername(username) {
  const snap = await db.ref(`${ROOT}/usernames/${username}`).get();
  const uid = snap.val();
  if (!uid) return show("search");
  const p = await db.ref(`${ROOT}/profiles/${uid}`).get();
  if (p.exists()) openChat({ uid, ...p.val() });
  else show("search");
}

/* ---------------- chat ---------------- */
function teardown() {
  // .on() in the compat SDK can invoke a pending callback with an undefined
  // snapshot while detaching, so every listener body guards on the snapshot.
  try { if (unsubMessages) unsubMessages(); } catch (e) {}
  try { if (unsubInbox) unsubInbox(); } catch (e) {}
  unsubMessages = null;
  unsubInbox = null;
  editingKey = null;
  exitEditMode();
}

$("back").onclick = () => {
  teardown();
  peer = null;
  history.replaceState(null, "", "#");
  show("search");
};

async function openChat(p) {
  teardown();
  peer = p;
  $("peer-name").textContent = p.displayName || p.username;
  $("peer-username").textContent = p.username;
  avatarFor($("peer-avatar"), p);
  $("thread").innerHTML = "";
  show("chat");
  history.replaceState(null, "", "#/u/" + p.username);

  const key = convoKey(me.uid, p.uid);
  try {
    await db.ref(`${ROOT}/conversations/${key}/meta/${me.uid}`).set(true);
  } catch (e) { return toast(friendly(e)); }

  try {
    const snap = await db
      .ref(`${ROOT}/conversations/${key}/messages`)
      .orderByChild("createdAt")
      .limitToLast(200)
      .get();

    $("thread").innerHTML = "";
    if (!snap.exists()) {
      const e = document.createElement("div");
      e.className = "empty";
      e.textContent = "ابدأ المحادثة 👋";
      $("thread").appendChild(e);
    } else {
      Object.entries(snap.val()).forEach(([k, m]) => renderBubble(k, m, true));
    }
    scrollDown();
  } catch (e) { toast(friendly(e)); }

  unsubMessages = db
    .ref(`${ROOT}/conversations/${key}/messages`)
    .orderByChild("createdAt")
    .limitToLast(200)
    .on("child_added", (s) => {
      if (!s || !peer) return;
      renderBubble(s.key, s.val());
    })
    .on("child_changed", (s) => {
      if (!s || !peer) return;
      const m = s.val();
      if (!m) return;
      const node = $("thread").querySelector(`[data-id="${s.key}"]`);
      const wasDeleted = node?.dataset.deleted === "1";
      const isDeleted = m.deleted === true;

      if (isDeleted && !wasDeleted) {
        toast("🗑 تم حذف رسالة");
        renderBubble(s.key, m);
      } else if (wasDeleted && !isDeleted) {
        renderBubble(s.key, m);
      } else {
        updateBubbleText(s.key, m);
      }
    });
}

/* --------- rendering --------- */
function renderBubble(key, m, quiet) {
  const empty = $("thread").querySelector(".empty");
  if (empty) empty.remove();

  const mine = m.senderId === me.uid;
  const b = document.createElement("div");
  b.className = "bubble " + (mine ? "me" : "you") + (m.deleted ? " gone" : "");
  b.dataset.id = key;
  if (m.deleted) b.dataset.deleted = "1";

  const txt = document.createElement("span");
  txt.className = "txt";
  txt.textContent = m.deleted ? "تم حذف الرسالة" : m.body;
  b.appendChild(txt);

  const meta = document.createElement("span");
  meta.className = "t";
  const bits = [hhmm(m.createdAt)];
  if (m.editedAt) bits.push("معدّلة");
  meta.textContent = bits.join(" · ");
  b.appendChild(meta);

  if (!m.deleted) attachActions(b, key, m, mine);

  const old = $("thread").querySelector(`[data-id="${key}"]`);
  if (old) old.replaceWith(b);
  else $("thread").appendChild(b);
  if (!quiet) scrollDown();
}

function updateBubbleText(key, m) {
  const b = $("thread").querySelector(`[data-id="${key}"]`);
  if (!b) return renderBubble(key, m);
  if (m.deleted) return renderBubble(key, m);
  const txt = b.querySelector(".txt");
  if (txt && txt.textContent !== m.body) txt.textContent = m.body;
  const meta = b.querySelector(".t");
  if (meta) {
    const bits = [hhmm(m.createdAt)];
    if (m.editedAt) bits.push("معدّلة");
    meta.textContent = bits.join(" · ");
  }
}

function attachActions(b, key, m, mine) {
  const bar = document.createElement("span");
  bar.className = "acts";

  if (mine) {
    const e = document.createElement("button");
    e.type = "button"; e.textContent = "✏️ تعديل"; e.title = "تعديل";
    e.onclick = (ev) => { ev.stopPropagation(); startEdit(key, m.body); };
    const d = document.createElement("button");
    d.type = "button"; d.textContent = "🗑 حذف"; d.title = "حذف";
    d.className = "danger";
    d.onclick = (ev) => { ev.stopPropagation(); confirmDelete(key); };
    bar.append(e, d);
  }

  b.appendChild(bar);
  b.addEventListener("dblclick", () => mine && startEdit(key, m.body));
}

// tap a bubble to reveal its actions (touch-friendly; no hover on phones)
$("thread").addEventListener("click", (ev) => {
  if (ev.target.closest(".acts")) return;
  const b = ev.target.closest(".bubble");
  if (!b || b.classList.contains("gone")) return;
  const wasOpen = b.classList.contains("open");
  $("thread").querySelectorAll(".bubble.open").forEach((x) => x.classList.remove("open"));
  if (!wasOpen) b.classList.add("open");
});

function scrollDown() {
  const th = $("thread");
  th.scrollTop = th.scrollHeight;
}

function watchInbox() {
  const ref = db.ref(`${ROOT}/conversations`);
  unsubInbox = ref.on("child_added", (snap) => {
    if (!snap || !snap.ref || !me) return;
    const convRef = snap.ref;
    convRef.child("meta").child(me.uid).get().then((mine) => {
      if (!mine || !mine.exists()) return;
      convRef.child("messages").orderByChild("createdAt").limitToLast(1)
        .on("value", (s) => {
          if (!s) return;
          const all = s.val();
          if (!all) return;
          const last = Object.entries(all).pop();
          if (last && last[1].senderId !== me.uid && !last[1].deleted) {
            toast(`📨 ${last[1].body.slice(0, 40)}`);
          }
        });
    });
  });
}

/* ---------------- edit ---------------- */
function startEdit(key, body) {
  editingKey = key;
  const box = $("msg");
  box.value = body;
  box.focus();
  box.setSelectionRange(body.length, body.length);
  box.style.height = "auto";
  box.style.height = Math.min(box.scrollHeight, 120) + "px";
  $("send").textContent = "💾 حفظ";
  $("composer").classList.add("editing");
  $("cancel-edit").classList.remove("hidden");
}

function exitEditMode() {
  if (editingKey === null && !$("composer").classList.contains("editing")) return;
  editingKey = null;
  $("composer").classList.remove("editing");
  $("cancel-edit").classList.add("hidden");
  $("send").textContent = "➤";
}

$("cancel-edit").onclick = () => {
  exitEditMode();
  $("msg").value = "";
};

async function confirmDelete(key) {
  const b = $("thread").querySelector(`[data-id="${key}"]`);
  if (b && !confirm("تحذف الرسالة؟ ما بنقدر نرجّعها")) return;
  try {
    await db.ref(`${ROOT}/conversations/${convoKey(me.uid, peer.uid)}/messages/${key}`)
      .update({ deleted: true, body: null });
    toast("🗑 تم الحذف");
  } catch (e) {
    toast(friendly(e));
  }
}

/* ---------------- send ---------------- */
const msgBox = $("msg");
msgBox.addEventListener("input", () => {
  msgBox.style.height = "auto";
  msgBox.style.height = Math.min(msgBox.scrollHeight, 120) + "px";
});

$("composer").onsubmit = async (ev) => {
  ev.preventDefault();
  const body = msgBox.value.trim();
  if (!body || sending || !peer) return;
  if (body.length > 4000) return toast("الرسالة طويلة (4000 حرف كحد أقصى)");

  sending = true;
  const msgRef = db.ref(`${ROOT}/conversations/${convoKey(me.uid, peer.uid)}/messages`);

  try {
    if (editingKey !== null) {
      const key = editingKey;
      const clean = msgBox.value;
      await msgRef.child(key).update({ body: clean, editedAt: Date.now() });
      exitEditMode();
      msgBox.value = "";
      msgBox.style.height = "auto";
    } else {
      await msgRef.push({ senderId: me.uid, body, createdAt: Date.now() });
      msgBox.value = "";
      msgBox.style.height = "auto";
    }
  } catch (e) {
    toast(friendly(e));
  } finally {
    sending = false;
  }
};
