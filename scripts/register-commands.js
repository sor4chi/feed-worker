const applicationId = process.env.DISCORD_APPLICATION_ID;
const botToken = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;

if (!applicationId || !botToken) {
  console.error("DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN are required.");
  process.exit(1);
}

const url = guildId
  ? `https://discord.com/api/v10/applications/${applicationId}/guilds/${guildId}/commands`
  : `https://discord.com/api/v10/applications/${applicationId}/commands`;

const commands = [
  {
    name: "feed",
    description: "RSS/Atom フィード購読を管理します",
    options: [
      {
        type: 1,
        name: "subscribe",
        description: "チャンネルにフィードを追加",
        options: [
          {
            type: 3,
            name: "url",
            description: "フィードの URL",
            required: true
          }
        ]
      },
      {
        type: 1,
        name: "list",
        description: "サーバー内の購読一覧"
      },
      {
        type: 1,
        name: "unsubscribe",
        description: "購読解除",
        options: [
          {
            type: 3,
            name: "subscribed_id",
            description: "購読 ID",
            required: true
          }
        ]
      }
    ]
  }
];

const response = await fetch(url, {
  method: "PUT",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bot ${botToken}`
  },
  body: JSON.stringify(commands)
});

if (!response.ok) {
  const text = await response.text();
  console.error(`Failed to register commands (${response.status}): ${text}`);
  process.exit(1);
}

const data = await response.json();
console.log("Registered commands:", data.map((command) => command.name).join(", "));
