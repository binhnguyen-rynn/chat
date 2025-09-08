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
  type: { type: String, enum: ['ai', 'doctor'], default: 'ai' },
  doctor: {
    name: String,
    specialty: String,
    hospital: String,
    experience: Number
  },
  pendingDoctor: { type: Object, default: null },
  messages: { type: [MessageSchema], default: [] },
  summary: { type: String, default: "" }
});

const DoctorSchema = new mongoose.Schema({
  name: { type: String, required: true },
  specialty: { type: String, required: true },
  hospital: { type: String },
  experience: { type: Number },
  createdAt: { type: Date, default: Date.now }
});

const Conversation = mongoose.model('Conversation', ConversationSchema);
const Doctor = mongoose.model("Doctor", DoctorSchema);

/* -------------------- Gemini setup -------------------- */
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

// Nhận dạng mong muôn gặp bác sĩ

async function detectDoctorIntent(text, model) {
  const triageprompt = `
Bạn là một bộ phân loại ngôn ngữ.
Nhiệm vụ: xác định xem người dùng có **MUỐN gặp bác sĩ** hay không.

- Nếu người dùng MUỐN gặp bác sĩ → trả về: "yes"
- Nếu người dùng KHÔNG MUỐN hoặc PHỦ ĐỊNH → trả về: "no"
- Không cần giải thích thêm.

Câu người dùng: "${text}"
  `;

  const result = await model.generateContent(triageprompt);
  const answer = result.response.text().trim().toLowerCase();

  return answer.includes("yes");
}

/* -------------------- ROUTES -------------------- */

// ✅ Tạo conversation mới
app.post('/conversation', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId là bắt buộc' });

    const convo = new Conversation({ userId, messages: [] });
    await convo.save();

    res.json({ success: true, id: convo._id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* -------------------- CHAT ROUTE -------------------- */
app.post('/chat/:conversationId', async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { userId, question } = req.body;

    if (!userId || !question) {
      return res.status(400).json({ error: 'userId và question là bắt buộc' });
    }

    const convo = await Conversation.findById(conversationId);
    if (!convo) return res.status(404).json({ error: "Conversation not found" });

    // Lưu tin nhắn user
    convo.messages.push({ role: "user", content: question });

    const lower = question.toLowerCase();

    /* ===== 1. Nếu đang chờ xác nhận bác sĩ ===== */
    if (convo.pendingDoctor) {
      if (["có", "ok", "đúng", "yes"].some(w => lower.includes(w))) {
        convo.type = "doctor";
        convo.doctor = convo.pendingDoctor;
        convo.pendingDoctor = null;

        const notify = `✅ Bạn đã được chuyển sang mục chat với bác sĩ ${convo.doctor.specialty} (${convo.doctor.name}).`;
        convo.messages.push({ role: "assistant", content: notify });
        await convo.save();
        return res.json({ success: true, answer: notify, messages: convo.messages, doctor: convo.doctor });
      } else if (["không", "no", "từ chối"].some(w => lower.includes(w))) {
        convo.pendingDoctor = null;
        const notify = "❌ Bạn đã từ chối chuyển sang bác sĩ. Tiếp tục chat với AI.";
        convo.messages.push({ role: "assistant", content: notify });
        await convo.save();
        return res.json({ success: true, answer: notify, messages: convo.messages });
      }
    }

    /* ===== 2. Nếu đang ở chế độ bác sĩ ===== */
    if (convo.type === "doctor" && convo.doctor) {
      const doctorPrompt = `
Bạn là ${convo.doctor.name}, chuyên khoa ${convo.doctor.specialty}, đang tư vấn cho bệnh nhân.
- Bạn có chuyên môn vừa phải, không đi khám sâu.
- Trả lời thân thiện, dễ hiểu, bằng tiếng Việt, giọng văn phù hợp bác sĩ.
- Không đưa ra chẩn đoán chắc chắn, chỉ gợi ý và khuyên bệnh nhân đi khám trực tiếp nếu cần.

Tin nhắn mới nhất từ bệnh nhân: "${question}"
`;

      const result = await model.generateContent(doctorPrompt);
      const answer = result?.response?.text() ?? "(Không có phản hồi)";

      convo.messages.push({ role: "assistant", content: answer });
      await convo.save();
      return res.json({ success: true, answer, messages: convo.messages, doctor: convo.doctor });
    }

    /* ===== 3. Nếu là AI bình thường ===== */
    // 3.1 Xác định user có muốn gặp bác sĩ không
    
    const wantsDoctor = await detectDoctorIntent(question, model);

    if (wantsDoctor) {
      // 3.2 Rule-based để đoán chuyên khoa
      let suggestedSpecialty = "Nội tổng quát";
      if (lower.includes("tim") || lower.includes("huyết áp")) suggestedSpecialty = "Tim mạch";
      else if (lower.includes("da") || lower.includes("mụn")) suggestedSpecialty = "Da liễu";
      else if (lower.includes("tai") || lower.includes("mũi") || lower.includes("họng")) suggestedSpecialty = "Tai mũi họng";

      let doctor = await Doctor.findOne({ specialty: suggestedSpecialty });
      if (doctor) {
        convo.pendingDoctor = doctor;
        const confirmMsg = `Bạn có muốn chuyển tiếp sang bác sĩ ${doctor.specialty} (${doctor.name}) để được tư vấn không? (Có / Không)`;
        convo.messages.push({ role: "assistant", content: confirmMsg });
        await convo.save();
        return res.json({ success: true, answer: confirmMsg, messages: convo.messages, pendingDoctor: doctor });
      }
    }

    // 3.3 Nếu không phân luồng → AI trả lời như y tá
    const aiPrompt = `
Bạn là Mediverse, một y tá có kiến thức y khoa cơ bản.
- Tư vấn sức khỏe cơ bản bằng tiếng Việt.
- Không thay thế chẩn đoán bác sĩ.
- Trả lời ngắn gọn, dễ hiểu.
- Dùng giọng văn thân thiện, tích cực, dễ gần.

Tin nhắn mới nhất từ người dùng: "${question}"
`;

    const result = await model.generateContent(aiPrompt);
    const answer = result?.response?.text() ?? "(Không có phản hồi)";

    convo.messages.push({ role: "assistant", content: answer });
    await convo.save();

    res.json({ success: true, answer, messages: convo.messages });

  } catch (err) {
    console.error("chat error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Lấy bác sĩ theo chuyên khoa



app.get("/doctor-info", async (req, res) => {
  try {
    const { userId } = req.query;

    // Lấy 3 cuộc trò chuyện gần nhất với bác sĩ
    const recentConvos = await Conversation.find({ userId, type: "doctor", doctor: { $ne: null } })
      .sort({ createdAt: -1 })
      .limit(3);

    const recent = recentConvos.map(c => c.doctor);

    // Gợi ý 1 bác sĩ bất kỳ (hoặc theo logic AI / rule-based)
    const suggested = await Doctor.findOne();

    res.json({
      success: true,
      recent,
      suggested
    });
  } catch (err) {
    console.error("doctor-info error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});


/* -------------------- Conversation APIs -------------------- */
// Lấy danh sách cuộc trò chuyện theo userId
app.get("/conversations/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    // ✅ Xóa các cuộc trò chuyện không có tin nhắn
    await Conversation.deleteMany({ messages: { $size: 0 } });

    // Lấy danh sách sau khi dọn
    const conversations = await Conversation.find({ userId }).sort({ createdAt: -1 });

    res.json({
      success: true,
      conversations: conversations.map(c => ({
        id: c._id,
        preview: c.messages[0]?.content.slice(0, 30) || "(Không có nội dung)"
      }))
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});


app.get('/conversation/:id', async (req, res) => {
  try {
    const convo = await Conversation.findById(req.params.id);
    if (!convo) return res.status(404).json({ error: "Not found" });
    res.json({ success: true, messages: convo.messages, doctor: convo.doctor });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/conversation/:id', async (req, res) => {
  try {
    const deleted = await Conversation.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ success: false, error: "Not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const triageRoute = async (req, res) => {
  try {
    const { userId, symptoms } = req.body;

    if (!userId || !symptoms) {
      return res.status(400).json({ success: false, error: "userId và symptoms là bắt buộc" });
    }

    // 🚀 Logic local: xác định chuyên khoa theo từ khóa (demo rule-based)
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

    // ✅ Trả về cả triage và doctor
    res.json({
      success: true,
      triage,
      doctor
    });

  } catch (err) {
    console.error("triage error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
};





// ✅ Lấy lịch sử phân loại
app.get('/triages/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const list = await Triage.find({ userId }).sort({ createdAt: -1 });
    res.json({ success: true, triages: list });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ...existing code...
app.post('/end-temp-conversation/:tempConversationId', async (req, res) => {
  try {
    const { tempConversationId } = req.params;
    const tempConvo = await TempConversation.findById(tempConversationId);
    if (!tempConvo) return res.status(404).json({ error: "TempConversation not found" });

    // Lưu ngày-giờ tin nhắn đầu tiên vào Conversation cố định
    const firstMsgTime = tempConvo.messages[0]?.timestamp || tempConvo.createdAt;
    const fixedConvo = new Conversation({
      userId: tempConvo.userId,
      createdAt: firstMsgTime,
      messages: [] // Không lưu chi tiết tin nhắn
    });
    await fixedConvo.save();

    // Xóa hội thoại tạm
    await TempConversation.findByIdAndDelete(tempConversationId);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
// ...existing code...

app.post("/triage", triageRoute);

/* -------------------- Health check -------------------- */
app.get('/', (_, res) => res.send('AI chat + doctor flow backend OK 🚑'));

app.listen(PORT, () => {
  console.log(`✅ Server chạy: http://localhost:${PORT}`);
});
