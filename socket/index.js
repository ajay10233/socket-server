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

    socket.on("join", (userId) => {
      console.log("👥 User joined:", userId);
      if (userId) {
        if (!userSockets.has(userId)) {
          userSockets.set(userId, new Set());
        }
        userSockets.get(userId).add(socket.id);
        userStatus.set(userId, 'connected');
        console.log(`User ${userId} stored with socket ID ${socket.id}`);
      }
    });



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

    socket.on("sendMessage", async ({ senderId, senderType, receiverId, conversationId, content, timestamp, accepted }) => {
      if (!senderId || !receiverId || !content || !senderType) return;

      // Identify the other party's type
      const receiver = await prisma.user.findUnique({
        where: { id: receiverId },
        select: { role: true }, // assuming role is either 'USER' or 'INSTITUTION'
      });

      if (!receiver) return;

      let expiresAt = null;
      const now = new Date();

      if (senderType === "USER" && receiver.role === "USER") {
        // User to User chat – expires in 48 hours
        expiresAt = new Date(now.getTime() + 48 * 60 * 60 * 1000);
      } else {
        // One side is institution
        const institutionId = senderType === "INSTITUTION" ? senderId : receiverId;
        const institution = await prisma.user.findUnique({
          where: { id: institutionId },
          select: { subscriptionPlan: true }, // plan: 'BASIC' | 'BUSINESS' | 'PREMIUM' | null
        });

        if (!institution || institution.subscriptionPlan?.name === 'BASIC' || institution.subscriptionPlan?.name === null) {
          expiresAt = new Date(now.getTime() + 48 * 60 * 60 * 1000);
        } else if (institution.subscriptionPlan?.name === 'BUSINESS') {
          expiresAt = new Date(now.getTime() + 48 * 60 * 60 * 1000);
        } else if (institution.subscriptionPlan?.name === 'PREMIUM') {
          expiresAt = null; // Never expires
        }
      }

      // Find or create conversation
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
            data: { user1Id: senderId, user2Id: receiverId, accepted },
          });
          conversationId = newConversation.id;
        }
      }

      // Create the message
      const newMessage = await prisma.message.create({
        data: {
          senderId,
          senderType,
          receiverId,
          content,
          conversationId,
          expiresAt, // <- This is the new field
        },
      });

      // Update conversation metadata
      await prisma.conversation.update({
        where: { id: conversationId },
        data: {
          lastMessageId: newMessage.id,
          lastMessageContent: newMessage.content,
          lastMessageTimestamp: newMessage.timestamp,
          lastMessageSenderId: newMessage.senderId,
        },
      });

      // Emit the message to all sockets of the receiver
      const sockets = userSockets.get(receiverId) || new Set();
      sockets.forEach((sid) => {
        io.to(sid).emit("receiveMessage", {
          senderId,
          senderType,
          receiverId,
          content,
          conversationId,
          timestamp,
          expiresAt,
        });
      });
    });

    socket.on("sendNotification", async({ toUserId, message,fromUserId,status }) => {
      // console.log("📢 Notification received:", { toUserId, message,fromUserId,status });
      if (!toUserId || !message|| !fromUserId) {
        return console.error("❌ Invalid notification payload");
      }

      try {
        const document = await prisma.notification.create({
          data: {
            receiverId:toUserId,
            message:message,
            senderId:fromUserId,
            type:status?status:"message",
          },
        })

        console.log("📢 Notification created:", document);
      } catch (error) {
        console.error("❌ Error creating notification:", error);
      }

      const sockets = userSockets.get(toUserId);

      if (!sockets || sockets.size === 0) {
        console.log(`📢 Notification for user ${toUserId} failed – user is offline`);
        return;
      }

      sockets.forEach((sid) => {
        io.to(sid).emit("receiveNotification", {
          message,
          fromUserId,
          status,
        });
        console.log(`📨 Notification sent to ${toUserId} at socket ${sid}`);
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
            console.log(`⚫ User ${userId} went offline`);
          }
          break;
        }
      }
    });

  });

  console.log("🚀 Socket.IO initialized");
};
