// MongoDB Playground
// Use Ctrl+Space inside a snippet or a string literal to trigger completions.

// The current database to use.
use("test");

db.patients.find({ fullName: /Benjamin/i })

//atualziar dat pagamento
 db.payments.updateOne(
  { _id: ObjectId("699850e87c92d32c1fd3e903") },
  {
    $set: {
      paymentDate: "2026-02-16"
    }
  }
)