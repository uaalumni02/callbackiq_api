import express from "express";
import "dotenv/config";
import cookieParser from "cookie-parser";

import connectDB from "./db/connection.js";
import authRoutes from "./routes/auth.routes.js";

const app = express();
const port = process.env.PORT || 3000;

app.set("trust proxy", 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

connectDB();

app.use("/api/auth", authRoutes);

app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    message: "CallBackIQ API is running",
  });
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
