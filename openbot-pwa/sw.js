const CACHE = "openbot-pwa-v2";
const CORE = [
    "./",
    "./index.html",
    "./style.css",
    "./js/transport.js",
    "./js/app.js",
    "./manifest.webmanifest",
    "./assets/icon.svg",
];
self.addEventListener("install", (e) =>
    e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE))),
);
self.addEventListener("activate", (e) =>
    e.waitUntil(
        caches
            .keys()
            .then((keys) =>
                Promise.all(
                    keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
                ),
            ),
    ),
);
self.addEventListener("fetch", (e) => {
    if (e.request.method !== "GET") return;
    e.respondWith(
        caches.match(e.request).then(
            (cached) =>
                cached ||
                fetch(e.request)
                    .then((res) => {
                        if (res.ok && new URL(e.request.url).origin === location.origin) {
                            const copy = res.clone();
                            caches.open(CACHE).then((c) => c.put(e.request, copy));
                        }
                        return res;
                    })
                    .catch(() => caches.match("./index.html")),
        ),
    );
});
