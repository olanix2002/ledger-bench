import { openDb } from "./db.js";
import { createApp } from "./app.js";

const db = openDb(process.env.DB_PATH ?? "ledger.db");
const port = Number(process.env.PORT ?? 3000);
createApp(db).listen(port, () => console.log(`ledger listening on :${port}`));
