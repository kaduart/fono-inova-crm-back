import mongoose from "mongoose";

function isObjectIdType(st) {
    // cobre ObjectId, arrays de ObjectId e refs em subdocs
    if (!st) return false;
    if (st.instance === "ObjectId" || st.instance === "ObjectID") return true;
    if (st.$isMongooseArray && st.caster && (st.caster.instance === "ObjectId" || st.caster.instance === "ObjectID")) return true;
    return false;
}

mongoose.plugin((schema) => {
    const objectIdPaths = [];

    schema.eachPath((path, st) => {
        if (isObjectIdType(st)) objectIdPaths.push(path);
    });

    if (!objectIdPaths.length) return;

    schema.pre("validate", function (next) {
        try {
            const bad = [];

            for (const p of objectIdPaths) {
                const v = this.get(p);
                if (v === false || v === true) {
                    bad.push({ path: p, value: v });
                    // ✅ AIRBAG: evita crash
                    this.set(p, null);
                }
            }

            if (bad.length) {
                console.error("🚨 BOOLEAN EM ObjectId PATH (auto-fix -> null)", {
                    model: this.constructor?.modelName,
                    _id: this._id,
                    bad,
                });
            }

            next();
        } catch (e) {
            next(e);
        }
    });
});
