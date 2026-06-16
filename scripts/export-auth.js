/**
 * Playwright Session Exporter Script
 *
 * Paste this script into your browser's Developer Tools Console (F12)
 * on the target website after you have logged in.
 *
 * It will format your localStorage and Cookies (non-HttpOnly) into a
 * JSON string conforming to the Playwright storageState layout and
 * copy it directly to your Clipboard.
 */
(function () {
  const origin = window.location.origin;
  const hostname = window.location.hostname;

  // 1. Extract non-HttpOnly Cookies
  const cookies = document.cookie
    ? document.cookie.split(";").map((c) => {
        const [name, ...valueParts] = c.trim().split("=");
        return {
          name: name.trim(),
          value: valueParts.join("=").trim(),
          domain: hostname,
          path: "/",
          expires: -1,
          httpOnly: false, // JavaScript cannot read HttpOnly flags
          secure: window.location.protocol === "https:",
          sameSite: "Lax",
        };
      })
    : [];

  // 2. Extract LocalStorage items
  const localStorageItems = Object.entries(localStorage).map(
    ([name, value]) => ({
      name,
      value,
    }),
  );

  // 3. Format to Playwright's auth state schema
  const authState = {
    cookies: cookies,
    origins: [
      {
        origin: origin,
        localStorage: localStorageItems,
      },
    ],
  };

  // 4. Copy to Clipboard
  copy(JSON.stringify(authState, null, 2));

  console.log(
    "%c Successfully copied Cookie & LocalStorage session data! ",
    "background: #222; color: #bada55; font-size: 16px; font-weight: bold;",
  );
  console.log("👉 Next Steps:");
  console.log(
    "1. Create a per-domain file under the 'auth/' directory in your strix project root, named after the site hostname (e.g. 'auth/" +
      hostname +
      ".json'). See 'auth/auth.example.json' for the schema.",
  );
  console.log(
    "2. Paste (Ctrl+V or Cmd+V) the copied JSON content into that file.",
  );
  console.log(
    "⚠️ Note: If the website uses secure 'HttpOnly' cookies for authentication, please export cookies using browser extensions like 'Cookie-Editor' and merge them into the 'cookies' array of that file.",
  );
})();
