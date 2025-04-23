// socket/index.js
import { Server } from "socket.io";
import { prisma } from "../utils/db.js";

const userSockets = new Map();
const userStatus = new Map();

export const initializeSocket = (server) => {
  const io = new Server(server, {
    cors: { origin: "*" },
  });

  io.on("connection", (socket) => {
    console.log("🔵 User connected:", socket.id);

    socket.on("joinInstitutionRoom", async (institutionId) => {
      if (!institutionId) return console.error("❌ Missing institutionId");
      socket.join(`institution:${institutionId}`);
      console.log(`👥 User joined institution room: ${institutionId}`);

      const activeToken = await prisma.token.findFirst({
        where: { institutionId, completed: false },
        orderBy: { createdAt: "desc" },
      });

      const completedTokens = await prisma.token.findMany({
        where: { institutionId, completed: true },
        orderBy: { createdAt: "desc" },
        take: 10,
        include: {
          user: {
            select: {
              username: true,
              mobileNumber: true,
            },
          },
        },
      });

      socket.emit("tokenUpdated", activeToken);
      socket.emit("completedTokensUpdated", completedTokens);
    });

    socket.on("newToken", async ({ institutionId, token }) => {
      let enrichedToken = token;
      if (token.userId) {
        const user = await prisma.user.findUnique({
          where: { id: token.userId },
          select: { username: true, mobileNumber: true },
        });

        if (user) {
          enrichedToken = { ...token, ...user };
        }
      }

      io.to(`institution:${institutionId}`).emit("tokenUpdated", enrichedToken);
    });

    socket.on("startProcessing", async ({ institutionId, tokenId }) => {
      const processingToken = await prisma.token.update({
        where: { id: tokenId },
        data: { processing: true },
        include: {
          user: {
            select: {
              username: true,
              mobileNumber: true,
            },
          },
        },
      });

      const tokenWithUser = {
        ...processingToken,
        username: processingToken.user?.username || null,
        mobileNumber: processingToken.user?.mobileNumber || null,
      };

      io.to(`institution:${institutionId}`).emit("processingTokenUpdated", tokenWithUser);
    });

    socket.on("completeToken", async ({ institutionId, tokenId }) => {
      await prisma.token.update({
        where: { id: tokenId },
        data: { completed: true, processing: false },
      });

      const completedTokens = await prisma.token.findMany({
        where: { institutionId, completed: true },
        orderBy: { createdAt: "desc" },
        take: 10,
        include: {
          user: {
            select: {
              username: true,
              mobileNumber: true,
            },
          },
        },
      });

      const enriched = completedTokens.map((t) => ({
        ...t,
        username: t.user?.username || null,
        mobileNumber: t.user?.mobileNumber || null,
      }));

      io.to(`institution:${institutionId}`).emit("completedTokensUpdated", enriched);
    });

    socket.on("getCurrentProcessingTokens", async (institutionId, callback) => {
      if (!institutionId) return callback([]);

      try {
        const processingTokens = await prisma.token.findMany({
          where: { institutionId, processing: true, completed: false },
          include: {
            user: {
              select: {
                username: true,
                mobileNumber: true,
              },
            },
          },
          orderBy: { createdAt: "asc" },
        });
        callback(processingTokens);
      } catch (error) {
        console.error("❌ Error fetching processing tokens:", error);
        callback([]);
      }
    });

    // Chat features
    socket.on("register", async (userId) => {
      if (!userId) return console.error("❌ Missing userId in register event");

      if (!userSockets.has(userId)) userSockets.set(userId, new Set());
      userSockets.get(userId).add(socket.id);
      userStatus.set(userId, "online");

      io.emit("presenceUpdate", { userId, status: "online" });
    });

    socket.on("sendMessage", async ({ senderId, senderType, receiverId, conversationId, content, timestamp }) => {
      if (!senderId || !receiverId || !content || !senderType) return;

      if (!conversationId) {
        const existingConversation = await prisma.conversation.findFirst({
          where: {
            OR: [
              { user1Id: senderId, user2Id: receiverId },
              { user1Id: receiverId, user2Id: senderId },
            ],
          },
          select: { id: true },
        });

        if (existingConversation) {
          conversationId = existingConversation.id;
        } else {
          const newConversation = await prisma.conversation.create({
            data: { user1Id: senderId, user2Id: receiverId },
          });
          conversationId = newConversation.id;
        }
      }

      const newMessage = await prisma.message.create({
        data: { senderId, senderType, receiverId, content, conversationId },
      });

      await prisma.conversation.update({
        where: { id: conversationId },
        data: {
          lastMessageId: newMessage.id,
          lastMessageContent: newMessage.content,
          lastMessageTimestamp: newMessage.timestamp,
          lastMessageSenderId: newMessage.senderId,
        },
      });

      const sockets = userSockets.get(receiverId) || new Set();
      sockets.forEach((sid) => {
        io.to(sid).emit("receiveMessage", {
          senderId, senderType, receiverId, content, conversationId, timestamp
        });
      });
    });

    socket.on("disconnect", () => {
      for (const [userId, sockets] of userSockets.entries()) {
        if (sockets.has(socket.id)) {
          sockets.delete(socket.id);
          if (sockets.size === 0) {
            userSockets.delete(userId);
            userStatus.set(userId, "offline");
            io.emit("presenceUpdate", { userId, status: "offline" });
            console.log(`⚫ User ${userId} is offline`);
          }
          break;
        }
      }
    });
  });

  console.log("🚀 Socket.IO initialized");
};
