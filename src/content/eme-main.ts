// Runs in the page's own JavaScript world at document start. When a media
// element is given decryption keys (EME), the page is playing DRM-protected
// video; tell the extension which key system, through the bridge script.
// Asking which systems exist is not enough, since players probe that for
// clear video too.

const proto = HTMLMediaElement.prototype;
const original = proto.setMediaKeys;
if (original) {
  proto.setMediaKeys = function (this: HTMLMediaElement, keys: MediaKeys | null) {
    if (keys) {
      try {
        const system = (keys as MediaKeys & { keySystem?: string }).keySystem ?? keySystems.get(keys) ?? "unknown";
        window.postMessage({ __vidzilla: "eme", keySystem: system }, "*");
      } catch {
        // Never break the page's player.
      }
    }
    return original.call(this, keys);
  };
}

// Encrypted media announces itself with an "encrypted" event when its init
// data arrives, even where no CDM is installed and setMediaKeys never runs.
// The event doesn't bubble, so listen in the capture phase.
window.addEventListener(
  "encrypted",
  (e) => {
    if (e.target instanceof HTMLMediaElement) window.postMessage({ __vidzilla: "eme", keySystem: "encrypted" }, "*");
  },
  true,
);

// MediaKeys doesn't expose its key system; remember it from the access object.
const keySystems = new WeakMap<MediaKeys, string>();
const request = navigator.requestMediaKeySystemAccess?.bind(navigator);
if (request) {
  navigator.requestMediaKeySystemAccess = async (keySystem, configs) => {
    const access = await request(keySystem, configs);
    const create = access.createMediaKeys.bind(access);
    access.createMediaKeys = async () => {
      const keys = await create();
      keySystems.set(keys, access.keySystem);
      return keys;
    };
    return access;
  };
}
