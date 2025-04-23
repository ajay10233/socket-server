// server.js
import express from "express";
import http from "http";
import cors from "cors";
import { initializeSocket } from "./socket/index.js";

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Server is running with Socket.IO + Prisma!");
});

initializeSocket(server);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
