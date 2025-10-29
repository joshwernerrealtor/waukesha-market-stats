// pages/api/rates.js
export default function handler(req, res) {
  res.status(410).json({
    status: 410,
    message: "The rates endpoint has been removed.",
    hint: "This site no longer displays lender rates."
  });
}
