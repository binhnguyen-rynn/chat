// server.js
import 'dotenv/config';
import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import { GoogleGenerativeAI } from '@google/generative-ai';

const app = express();
app.use(express.json());
app.use(cors({ origin: true }));

/* -------------------- MongoDB connect -------------------- */
const { MONGODB_URI, GEMINI_API_KEY, PORT = 5000 } = process.env;
if (!MONGODB_URI) throw new Error('Missing MONGODB_URI');
if (!GEMINI_API_KEY) throw new Error('Missing GEMINI_API_KEY');

await mongoose.connect(MONGODB_URI);

/* -------------------- Schema / Model -------------------- */
const MessageSchema = new mongoose.Schema({
  role: { type: String, enum: ['user', 'assistant'], required: true },
  content: { type: String, required: true },
  timestamp: { type: Date, default: Date.now }
}, { _id: false });

const ConversationSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  messages: { type: [MessageSchema], default: [] }
});

const TempConversationSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  createdAt: { type: Date, default: Date.now },
  messages: { type: [MessageSchema], default: [] },
  systemInstructions: { 
    type: String, 
    default: "You are a nurse. Your name is Mediverse. You have basic knowledge of medicine, healthcare, and health, always reply user by only vietnamese." 
  }
});
const TempConversation = mongoose.model('TempConversation', TempConversationSchema);

const TriageSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  symptoms: { type: String, required: true },
  suggestedSpecialty: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

const DoctorSchema = new mongoose.Schema({
  name: { type: String, required: true },
  specialty: { type: String, required: true },
  hospital: { type: String },
  experience: { type: Number },
  createdAt: { type: Date, default: Date.now }
});

const Conversation = mongoose.model('Conversation', ConversationSchema);
const Triage = mongoose.model('Triage', TriageSchema);
const Doctor = mongoose.model('Doctor', DoctorSchema);

/* -------------------- Gemini setup -------------------- */
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

/* -------------------- detectDoctorIntent -------------------- */
async function detectDoctorIntent(text) {
  if (!text) return false;
  const triageprompt = `
Bạn là một bộ phân loại ngôn ngữ.
Nhiệm vụ: xác định xem người dùng có **MUỐN gặp bác sĩ** hay không.

- Nếu người dùng MUỐN gặp bác sĩ → trả về: "yes"
- Nếu người dùng KHÔNG MUỐN hoặc PHỦ ĐỊNH → trả về: "no"
- Không cần giải thích thêm.

Câu người dùng: "${text}"
  `;

  const result = await model.generateContent(triageprompt);
  const answer = result?.response?.text?.().trim().toLowerCase() || "";
  return answer.includes("yes");
}

/* -------------------- ROUTES -------------------- */

// ✅ Tạo conversation tạm
app.post('/temp-conversation', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId là bắt buộc' });

    const tempConvo = new TempConversation({ userId, messages: [] });
    await tempConvo.save();

    res.json({ success: true, id: tempConvo._id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ✅ Chat trong hội thoại tạm
app.post('/temp-chat/:tempConversationId', async (req, res) => {
  try {
    const { tempConversationId } = req.params;
    const { userId, question } = req.body;

    if (!userId || !question) {
      return res.status(400).json({ error: 'userId và question là bắt buộc' });
    }

    const tempConvo = await TempConversation.findById(tempConversationId);
    if (!tempConvo) {
      return res.status(404).json({ error: "TempConversation not found" });
    }

    // Lưu tin nhắn user
    tempConvo.messages.push({ role: 'user', content: question });

    // ------------------- Check local phân luồng -------------------
    let triage = null;
    let doctor = null;

    const wantsDoctor = await detectDoctorIntent(question);

    if (wantsDoctor) {
      // 🚀 Rule-based chuyên khoa
      let suggestedSpecialty = "Nội tổng quát";
      const lower = question.toLowerCase();
      if (lower.includes("da") || lower.includes("mụn")) suggestedSpecialty = "Da liễu";
      else if (lower.includes("tim") || lower.includes("huyết áp")) suggestedSpecialty = "Tim mạch";
      else if (lower.includes("tai") || lower.includes("mũi") || lower.includes("họng")) suggestedSpecialty = "Tai mũi họng";

      triage = new Triage({ userId, symptoms: question, suggestedSpecialty });
      await triage.save();

      doctor = await Doctor.findOne({ specialty: suggestedSpecialty });
      if (!doctor) {
        doctor = {
          name: "Chưa có bác sĩ trong hệ thống",
          specialty: suggestedSpecialty,
          hospital: "Vui lòng đến bệnh viện gần nhất",
          experience: null
        };
      }
    }

    // ------------------- Gọi Gemini xử lý hội thoại -------------------
    const history = tempConvo.messages.map(m => `${m.role}: ${m.content}`).join('\n');
    const systemInstructions = tempConvo.systemInstructions;

    const finalprompt = `
${systemInstructions}

Đây là toàn bộ lịch sử hội thoại:
${history}
`;

    const result = await model.generateContent(finalprompt);
    const answer = result?.response?.text?.() ?? '(Không có phản hồi)';

    tempConvo.messages.push({ role: 'assistant', content: answer });
    await tempConvo.save();

    // ------------------- Trả về kết quả -------------------
    res.json({ 
      success: true, 
      answer, 
      messages: tempConvo.messages, 
      triage, 
      doctor 
    });

  } catch (err) {
    console.error("temp-chat error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* -------------------- TRIAGE ROUTE -------------------- */
const triageRoute = async (req, res) => {
  try {
    const { userId, symptoms } = req.body;

    if (!userId || !symptoms) {
      return res.status(400).json({ success: false, error: "userId và symptoms là bắt buộc" });
    }

    // 🚀 Rule-based chuyên khoa
    let suggestedSpecialty = "Nội tổng quát";
    const lowerSymptoms = symptoms.toLowerCase();

    if (lowerSymptoms.includes("da") || lowerSymptoms.includes("mụn")) {
      suggestedSpecialty = "Da liễu";
    } else if (lowerSymptoms.includes("tim") || lowerSymptoms.includes("huyết áp")) {
      suggestedSpecialty = "Tim mạch";
    } else if (lowerSymptoms.includes("tai") || lowerSymptoms.includes("mũi") || lowerSymptoms.includes("họng")) {
      suggestedSpecialty = "Tai mũi họng";
    }

    // Lưu triage
    const triage = new Triage({ userId, symptoms, suggestedSpecialty });
    await triage.save();

    // Tìm bác sĩ trong DB
    let doctor = await Doctor.findOne({ specialty: suggestedSpecialty });
    if (!doctor) {
      doctor = {
        name: "Chưa có bác sĩ trong hệ thống",
        specialty: suggestedSpecialty,
        hospital: "Vui lòng đến bệnh viện gần nhất",
        experience: null
      };
    }

    res.json({ success: true, triage, doctor });

  } catch (err) {
    console.error("triage error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
};
app.post("/triage", triageRoute);

/* -------------------- Health check -------------------- */
app.get('/', (_, res) => res.send('AI chat + triage backend OK 🚑'));

app.listen(PORT, () => {
  console.log(`✅ Server chạy: http://localhost:${PORT}`);
});
