# NOTE 1337 — Cơ chế Computer/VM Runtime cho OpenBotD.U_C

> Trạng thái: yêu cầu sản phẩm/runtime. Đây là contract mục tiêu cho Computer isolation, persistence, resource management và lifecycle của OpenBot Desktop.

## Mục tiêu

OpenBotD.U_C cần cho mỗi chatbot/Agent một môi trường máy tính riêng để có thể:

- dùng Browser;
- đọc/ghi Files;
- chạy lệnh và công cụ được cấp quyền;
- giữ trạng thái đăng nhập/browser/workspace;
- hoạt động lâu dài khi người dùng đang mở OpenBot;
- cách ly Agent khỏi máy Windows thật của người dùng.

## 1. Quy tắc chạy/tắt ứng dụng

Yêu cầu quan trọng:

**Khi OpenBotD.U_C đang mở:**

- Agent được phép tiếp tục hoạt động.
- Computer/VM/container của Agent có thể treo lâu dài.
- Browser session và workspace được giữ lại.
- Agent có thể tiếp tục công việc theo các quyền được cấp.
- Có thể chạy nền trong thời gian OpenBot vẫn đang hoạt động.

**Khi người dùng thoát hoàn toàn OpenBotD.U_C:**

- Dừng toàn bộ Agent runtime.
- Dừng Computer/VM/container.
- Dừng Browser automation.
- Dừng các process/service con do OpenBot khởi tạo.
- Không để chatbot âm thầm tiếp tục sử dụng CPU/RAM/GPU/network sau khi app đã tắt.
- Không có background service tự chạy lại nếu người dùng chưa mở OpenBot.

Phân biệt:

- **Minimize/thu nhỏ app:** vẫn được tiếp tục chạy.
- **Đóng cửa sổ nhưng chọn Keep running:** có thể tiếp tục chạy nếu sản phẩm cung cấp tùy chọn này.
- **Exit/Quit OpenBot:** phải dừng toàn bộ runtime.

Nên có setting:

`When closing OpenBot:`

- `Keep running in system tray`
- `Exit OpenBot and stop all Agents`

Người dùng phải biết rõ trạng thái nào đang chạy.

## 2. Computer của Agent không được coi như quyền truy cập trực tiếp toàn bộ máy thật

Agent không nên được cấp quyền trực tiếp không giới hạn vào Windows host.

Kiến trúc mong muốn:

```text
Windows Host
→ OpenBot Desktop
→ Computer Manager
→ môi trường cách ly Agent
→ Browser / Workspace / Tools
```

CPU/RAM/Disk vẫn đến từ phần cứng thật của máy, nhưng phải được OpenBot giới hạn và phân chia cho từng Agent.

Ví dụ:

**Agent A:**

- CPU limit
- RAM limit
- workspace riêng
- browser profile riêng

**Agent B:**

- CPU limit khác
- RAM riêng
- workspace riêng
- browser profile riêng

Agent không được mặc định nhìn thấy toàn bộ `C:\`, Desktop, Documents hoặc file cá nhân trên máy host.

## 3. Yêu cầu an toàn với virus/file lạ

Một Agent có thể truy cập Internet nên phải giả định rằng nó **có khả năng gặp file độc hại, website độc hại hoặc nội dung không đáng tin cậy**.

Do đó Computer của Agent phải cách ly với Windows host.

Mặc định:

- Không mount toàn bộ ổ C/D vào Agent.
- Không cho Agent tự ý đọc thư mục Windows thật.
- Không tự động thực thi file tải từ Internet trên host.
- File tải xuống phải nằm trong workspace/container/VM của Agent.
- Không chia sẻ clipboard host tùy ý.
- Không chia sẻ credential của Windows host.
- Không cho quyền Administrator.
- Không tự động mở USB/device.
- Không cho truy cập Windows registry của host.
- Không cho Agent tự cài driver/service vào host.

Nếu Agent tải malware thì mục tiêu là:

`malware → bị giữ trong môi trường Agent`

thay vì:

`malware → chạy trực tiếp trên Windows thật`.

Các thao tác nguy hiểm như đưa file từ Agent ra máy thật phải có bước xác nhận của người dùng.

## 4. Reset và phục hồi

Mỗi Computer nên hỗ trợ:

- Start
- Stop
- Restart
- Reset

`Restart`:

- không xóa browser profile;
- không xóa workspace;
- không đăng xuất tài khoản.

`Reset`:

- xóa môi trường của Agent;
- xóa browser profile;
- xóa session/login;
- loại bỏ file không mong muốn;
- tạo môi trường sạch.

Reset phải cần xác nhận rõ ràng vì đây là thao tác phá hủy dữ liệu.

Có thể bổ sung Snapshot:

`Clean snapshot → Agent hoạt động → có vấn đề → Restore snapshot`

để phục hồi nhanh nếu Agent tải file hoặc làm thay đổi không mong muốn.

## 5. Persistence

Khi Stop/Restart bình thường:

- Files của Agent vẫn còn.
- Browser profile vẫn còn.
- Login/session vẫn còn.
- Knowledge/config Agent vẫn còn.

Khi đóng OpenBot hoàn toàn:

- runtime ngừng;
- dữ liệu persistent vẫn được lưu;
- lần mở OpenBot tiếp theo có thể khôi phục Agent.

Không đồng nghĩa với việc Agent vẫn đang chạy sau khi app đã Exit.

## 6. Cấu hình máy hiện tại

Máy người dùng:

- Intel Core i5-12500H
- RTX 3050 Laptop 4 GB VRAM
- RAM 16 GB DDR4
- SSD 512 GB

Định hướng ưu tiên là môi trường nhẹ/container hoặc sandbox thay vì tạo nhiều Windows VM hoàn chỉnh.

### Mức sử dụng hợp lý

Với 16 GB RAM:

**2 Agent Computer hoạt động khá thoải mái** nếu đều sử dụng browser.

Có thể chạy:

**3 Agent nhẹ** nếu chỉ một hoặc hai Agent dùng browser nặng cùng lúc.

Không nên thiết kế mặc định để 5–10 Windows VM đầy đủ chạy đồng thời trên cấu hình này.

Ví dụ ngân sách:

```text
Host Windows + OpenBot: ~5–7 GB RAM
Agent Computer 1: ~2–3 GB
Agent Computer 2: ~2–3 GB
Agent Computer 3 nhẹ: ~1–2 GB
```

Phần RAM còn lại làm buffer cho Windows và ứng dụng khác.

OpenBot nên tự quan sát:

- CPU
- RAM
- Disk
- số Computer đang chạy

và cảnh báo trước khi mở thêm Agent Computer nếu máy sắp thiếu tài nguyên.

## 7. GPU

RTX 3050 4 GB không nên bị chia cứng cho từng Computer theo mặc định.

Browser/automation thông thường chủ yếu cần CPU/RAM.

GPU chỉ cấp khi workload thực sự cần.

Nếu sau này Agent chạy local AI model thì 4 GB VRAM là giới hạn khá lớn, vì vậy local LLM và Computer runtime nên được xem là hai hệ thống tài nguyên riêng.

## 8. Resource Manager

OpenBot nên có Computer Manager hiển thị cho từng Agent:

- Running / Stopped
- CPU %
- RAM đang dùng
- Disk đang dùng
- thời gian đã chạy
- Browser state
- workspace
- Network state

Có thể cung cấp profile:

**Light**

- 1 CPU-ish quota
- 1–1.5 GB RAM

**Normal**

- khoảng 2 CPU quota
- 2–3 GB RAM

**Heavy**

- khoảng 3–4 GB RAM
- CPU cao hơn

Không nhất thiết reserve cứng CPU core vật lý; có thể dùng quota/scheduler.

## 9. Auto resource management

Nếu Agent không hoạt động một thời gian:

`Running → Idle → Sleep`

Sleep:

- giải phóng phần lớn CPU/RAM;
- giữ persistent workspace/browser profile.

Có yêu cầu mới:

`Sleep → Wake`

Điều này giúp người dùng có nhiều Agent được cấu hình nhưng chỉ một số Computer thực sự chiếm RAM tại một thời điểm.

Ví dụ:

```text
10 Agent tồn tại
nhưng chỉ 2–3 Computer đang Running.
```

## 10. Quy tắc sản phẩm cuối cùng

Nguyên tắc mong muốn:

**App mở → Agent có thể hoạt động lâu dài.**

**App Exit hoàn toàn → tất cả Agent runtime phải dừng.**

**Agent có tài nguyên phần cứng nhưng không mặc định có toàn quyền đối với máy Windows thật.**

**Internet/file không đáng tin cậy phải được giữ trong sandbox/Computer.**

**Dữ liệu cần thiết được persist; process không được persist sau khi Exit.**

**Người dùng luôn có nút Stop / Restart / Reset / Kill All Computers.**

Nên có nút khẩn cấp:

`STOP ALL AGENTS`

Nút này phải dừng ngay:

- Agent execution;
- browser automation;
- computer runtime;
- command execution;
- network actions đang được OpenBot điều khiển.
