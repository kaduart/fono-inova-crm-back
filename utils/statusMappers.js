// utils/statusMappers.js
export const mapStatusToOperational = (status) => {
    switch ((status || "").toLowerCase()) {
        case "scheduled":
            return "scheduled";
        case "confirmed":
        case "completed":
            return "confirmed";
        case "paid":
            return "paid";
        case "canceled":
            return "canceled";
        case "missed":
            return "missed";
        default:
            return "scheduled";
    }
};

export const mapStatusToClinical = (status) => {
    switch ((status || "").toLowerCase()) {
        case "pending":
            return "pending";
        case "in_progress":
            return "in_progress";
        case "completed":
            return "completed";
        case "missed":
            return "missed";
        default:
            return "pending";
    }
};