const fs = require("fs");
const files = [
  "app/additional/chat-history/page.tsx",
  "components/dashboard/add-active-connection-dialog.tsx",
  "components/settings/connection-card.tsx",
  "components/settings/exchange-connection-dialog.tsx"
];

for (const file of files) {
  if (fs.existsSync(file)) {
    let content = fs.readFileSync(file, "utf8");
    content = content.replace(/'/g, "&apos;"); // This is dangerous, be more specific
  }
}
