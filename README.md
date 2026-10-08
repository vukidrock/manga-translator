# Manga Translator

Trình dịch truyện tranh chạy **hoàn toàn trong trình duyệt**: tự phát hiện bong bóng/ô chữ, OCR, xoá chữ bằng AI (inpainting), dịch, gõ lại bản dịch và xuất ảnh. Ảnh không rời khỏi máy bạn (trừ khi bạn bật dịch bằng Gemini).

## Tính năng

- **Nhận diện bong bóng & ô chữ** bằng model RT-DETR v2 (ONNX, chạy client-side).
- **OCR** (Tesseract.js) theo từng vùng, kèm tiền xử lý ảnh (xám hoá + Otsu) cho chữ truyện sạch hơn.
- **Xoá chữ AI** bằng LaMa manga (inpainting), giữ nét vẽ/viền bong bóng.
- **Dịch**:
  - Offline miễn phí (Transformers.js — opus-mt Anh↔Việt).
  - Hoặc **Gemini API** (đọc chữ + dịch theo ngữ cảnh) — tuỳ chọn, cần API key.
- **Khung đối chiếu** bản gốc | bản dịch, zoom sát từng vùng (double-click vào khung).
- **Sắp xếp danh sách trang** đúng thứ tự (natural sort), báo trạng thái từng trang (chưa nhận diện / chưa dịch / dở dang / đã dịch).
- **Thêm ảnh**: từ máy, từ URL ảnh, hoặc **URL trang chương** (đọc qua Jina Reader rồi trích ảnh).
- **Lưu project** tự động (IndexedDB), xuất/nhập `.mtproj`, xuất PNG/ZIP.
- Font hỗ trợ tiếng Việt, theme sáng/tối, tuỳ chỉnh kiểu chữ chung + riêng từng khung.

## Công nghệ

- Vanilla JavaScript (ES Modules), Canvas 2D, không build step.
- **ONNX Runtime Web** (WASM, đa luồng, proxy worker): RT-DETR (detect) + LaMa (inpaint).
- **Tesseract.js** (OCR), **Transformers.js** (dịch offline), **JSZip**.
- Tuỳ chọn **Google Gemini API** (REST) và **Jina Reader** (đọc HTML trang chương).

## Chạy local

Yêu cầu Node.js ≥ 20.

```bash
npm run serve
# mở http://localhost:5173
```

Server tĩnh (`scripts/serve.mjs`) đã set header **COOP/COEP** để bật đa luồng WASM (nhanh hơn). Nếu dùng server khác không có header này, tool vẫn chạy nhưng chậm hơn.

## Lần đầu sử dụng

- Các model (detect ~11MB, inpaint ~60MB) sẽ **tải một lần** rồi được cache trong trình duyệt.
- Dịch offline tải model opus-mt (~100MB) lần đầu.
- Muốn dùng Gemini: lấy API key ở Google AI Studio → menu **⋯ → Nguồn dịch: Gemini** → dán key (lưu trong máy).

## Ghi chú

- Chỉ hỗ trợ thêm ảnh bằng **URL ảnh trực tiếp** hoặc URL trang chương qua Jina; host phải cho phép CORS (có proxy ảnh dự phòng).
- Vài site dùng Cloudflare nâng cao / URL ký hạn / gallery render bằng JS phức tạp có thể không trích được.
- Tôn trọng bản quyền: chỉ dùng cho mục đích cá nhân/học tập.

## Deploy (ví dụ Firebase Hosting)

Cần set header COOP/COEP để có đa luồng, ví dụ `firebase.json`:

```json
{
  "hosting": {
    "public": ".",
    "ignore": ["firebase.json", "**/.*", "**/node_modules/**"],
    "headers": [
      {
        "source": "**",
        "headers": [
          { "key": "Cross-Origin-Opener-Policy", "value": "same-origin" },
          { "key": "Cross-Origin-Embedder-Policy", "value": "require-corp" }
        ]
      }
    ]
  }
}
```

## Giấy phép

MIT — xem [LICENSE](./LICENSE).
