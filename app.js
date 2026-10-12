/* Clock Dual - chat app (Firebase Realtime Database)
   Everything lives under /clockdual so it never touches other app data. */

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

/* ---------------- helpers ---------------- */
const convoKey = (a, b) => [a, b].sort().join("__");

function friendly(e) {
  const m = String(e?.message || e);
  if (/auth\/invalid-credential|wrong password|user-not-found/i.test(m))
    return "الإيميل أو كلمة السر غلط";
  if (/auth\/email-already-in-use/i.test(m)) return "هذا الإيميل مسجّل قبل";
  if (/auth\/weak-password/i.test(m)) return "كلمة السر ضعيفة (6 أحرف على الأقل)";
  if (/auth\/username.*taken|already exists/i.test(m)) return "اسم المستخدم محجوز";
  if (/PERMISSION_DENIED/i.test(m)) return "الصلاحية مرفوضة";
  if (/Failed to fetch|NetworkError|network/i.test(m)) return "ما في نت";
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
  if (isRegister && username.length < 2) {
    err.textContent = "اسم المستخدم لازم حرفين على الأقل";
    return;
  }

  const btn = $("auth-submit");
  btn.disabled = true;
  btn.textContent = "لحظة…";

  try {
    if (isRegister) {
      const cred = await auth.createUserWithEmailAndPassword(email, password);
      const displayName = $("displayname").value.trim() || username;
      // claim the username index BEFORE anything else can
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
  if (!user) return show("auth");
  try {
    const snap = await db.ref(`${ROOT}/profiles/${user.uid}`).get();
    me = snap.exists() ? { uid: user.uid, ...snap.val() } : null;
    if (!me) return show("auth");
    $("me-name").textContent = me.displayName || me.username;
    $("me-username").textContent = me.username;
    avatarFor($("me-avatar"), me);
    show("search");
    watchInbox();
    const m = location.hash.match(/^#\/u\/([\w.\-]+)$/);
    if (m) openByUsername(m[1]);
  } catch (e) {
    toast(friendly(e));
    show("auth");
  }
});

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
    // prefix search on the username index: startAt(q) .. endAt(q + high char)
    const snap = await db
      .ref(`${ROOT}/usernames`)
      .orderByKey()
      .startAt(q)
      .endAt(q + "￿")
      .limitToFirst(30)
      .get();

    const uids = Object.values(snap.val() || {}).filter((u) => u !== me.uid);
    if (!uids.length) {
      list.innerHTML = "";
      $("search-hint").textContent = "ما لقينا حدا";
      return;
    }

    const profs = await Promise.all(
      uids.map((u) => db.ref(`${ROOT}/profiles/${u}`).get())
    );
    const people = profs
      .filter((s) => s.exists())
      .map((s) => ({ uid: s.key, ...s.val() }))
      .filter((p) =>
        p.username.startsWith(q) || (p.displayName || "").toLowerCase().includes(q)
      )
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
  if (unsubMessages) { unsubMessages(); unsubMessages = null; }
  if (unsubInbox)    { unsubInbox();    unsubInbox = null; }
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
  // each side stamps its own flag -> unlocks .read for this conversation
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
      Object.values(snap.val()).forEach((m) => appendBubble(m, m.key, true));
    }
    scrollDown();
  } catch (e) { toast(friendly(e)); }

  unsubMessages = db
    .ref(`${ROOT}/conversations/${key}/messages`)
    .orderByChild("createdAt")
    .limitToLast(200)
    .on("child_added", (s) => {
      if ($("thread").querySelector(`[data-id="${s.key}"]`)) return;
      appendBubble(s.val(), s.key);
    });
}

function appendBubble(m, key, quiet) {
  const empty = $("thread").querySelector(".empty");
  if (empty) empty.remove();

  const mine = m.senderId === me.uid;
  const b = document.createElement("div");
  b.className = "bubble " + (mine ? "me" : "you");
  b.dataset.id = key;
  b.textContent = m.body;

  const t = document.createElement("span");
  t.className = "t";
  t.textContent = new Date(m.createdAt).toLocaleTimeString("ar", {
    hour: "2-digit", minute: "2-digit",
  });
  b.appendChild(t);
  $("thread").appendChild(b);
  if (!quiet) scrollDown();
}

function scrollDown() {
  const th = $("thread");
  th.scrollTop = th.scrollHeight;
}

function watchInbox() {
  unsubInbox = db.ref(`${ROOT}/conversations`).on("child_added", async (snap) => {
    const mine = await db.ref(`${ROOT}/conversations/${snap.key}/meta/${me.uid}`).get();
    if (!mine.exists()) return;
    snap.ref.child("messages").orderByChild("createdAt").limitToLast(1).on("value", (s) => {
      const last = s.val() && Object.values(s.val()).pop();
      if (last && last.senderId !== me.uid) toast(`📨 ${last.body.slice(0, 40)}`);
    });
  });
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

  sending = true;
  msgBox.value = "";
  msgBox.style.height = "auto";

  const key = convoKey(me.uid, peer.uid);
  const payload = {
    senderId: me.uid,
    body,
    createdAt: Date.now(),
    participants: { [me.uid]: true, [peer.uid]: true },
  };

  try {
    const ref = db.ref(`${ROOT}/conversations/${key}/messages`).push();
    await ref.set(payload);   // child_added listener renders it
  } catch (e) {
    msgBox.value = body;
    toast(friendly(e));
  } finally {
    sending = false;
  }
};
