// services/contactService.ts
import API from "./api";

export const contactService = {
    async list(params?: { search, tag }) {
        const res = await API.get("/contacts", { params });
        return res.data; // { success, data }
    },
    async upsert(payload: { name?; phone; tags?[] }) {
        const res = await API.post("/contacts/upsert", payload);
        return res.data;
    }
};
