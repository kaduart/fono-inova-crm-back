// routes/contacts.js
import express from "express";
import { listContacts, upsertContact } from "../controllers/contactController.js";
const router = express.Router();

router.get("/", listContacts);
router.post("/upsert", upsertContact);

export default router;
