# BIP.AD / Lucky Boost | Decision Brief cho coding agent

> Trạng thái: **Approved for implementation planning**  
> Phiên bản: `1.1` | Ngày: `2026-11-08` | Múi giờ mặc định: `Asia/Ho_Chi_Minh` (`UTC+07:00`)  
> Loại tài liệu: quyết định sản phẩm + kiến trúc tham chiếu + phạm vi triển khai + tiêu chí nghiệm thu.  
> **Chưa phải lệnh triển khai production.** Coding agent phải đọc codebase và tài liệu provider hiện tại, kiểm thử sandbox và báo cáo những điều kiện chưa đáp ứng trước khi bật tiền thật/quảng cáo thật.

## 0. Lệnh cho coding agent

**Mục tiêu:** xây BIP.AD, một mạng lưới quảng bá sản phẩm theo cơ chế đấu giá **continuous all-pay**. Người dùng dùng AI agent để đăng sản phẩm, xây trang giới thiệu và mua bid thông qua MCP. Grok Bot vận hành kiểm duyệt, tạo video, phân phối nội dung, chạy Ads và cập nhật số liệu, với hệ thống tài chính và thứ hạng có tính quyết định, kiểm toán được.

**Không được tự đổi các quyết định đã chốt:**

1. Tên miền dự kiến: `bip.ad`. Chưa mặc định đã được mua. Tên thương hiệu: `BIP.AD`; tên cơ chế trả phí: `Lucky Boost`.
2. **Chỉ** cho tạo và xuất bản sản phẩm qua `/mcp`; web chỉ xem listing/trang sản phẩm, tài khoản, checkout và analytics. Agent người dùng sử dụng MCP để đặt bid; checkout vẫn yêu cầu người thanh toán thực hiện/phê duyệt.
3. Có ba BXH **Daily, Weekly, Monthly**. **Cả ba khóa và chụp snapshot mỗi ngày lúc 03:12**, theo giờ Việt Nam.
4. Bid **liên tục**, cộng dồn theo sản phẩm và bảng, tăng bất cứ lúc nào, thứ hạng cập nhật ngay sau khi **xác nhận tiền đã nhận**. Bid cao đứng trên. Bị vượt hạng có thể mua thêm để vượt lại.
5. **All-pay:** tiền của tất cả bid thành công đều được thu, kể cả người ngoài Top 10. Không hoàn tiền chỉ vì mất hạng, không đạt Top 10 hoặc traffic thấp.
6. Sản phẩm miễn phí luôn được hiện ở phần dưới của BXH và vẫn có thể nhận impression/click từ traffic trả phí.
7. Snapshot Top 10 mỗi bảng được Grok Bot làm motion video, đăng lên X, Facebook, YouTube và đưa liên kết sản phẩm trong bình luận/bề mặt hỗ trợ. Những sản phẩm #11 trở xuống vẫn có exposure trên trang listing; Grok Bot có thể chọn thêm organic posts riêng, **không cam kết**.
8. Quảng cáo được tài trợ bằng **80% doanh thu bid đủ điều kiện** của từng bảng, tách biệt ba sổ tiền. Daily rải 1 ngày, Weekly 7 ngày, Monthly 30 ngày như thiết kế hiện tại. Chiến dịch có thể chồng nhau.
9. Grok Bot là operator chính, có Cloud Desktop/Browser với phiên đăng nhập sẵn, Zernio MCP/API/CLI cho social + Ads, Jev/TypeSafe làm decision layer. Nhưng **không giao cho LLM quyền thay đổi sổ cái, thứ hạng, hạn mức chi tiêu hoặc bỏ qua xác thực thanh toán**.
10. **Chỉ PayPal + SePay** để thu tiền. **Không Stripe, không Merchant of Record (MoR)**, không thêm phương án đó dưới dạng fallback.
11. **Chương trình giới thiệu (referral):** trả **5% hoa hồng cho lượt giới thiệu thành công**, ghi nhận qua sổ cái; người giới thiệu có thể **dùng hoa hồng để bid** hoặc **yêu cầu rút tiền**.
12. **Thứ tự xếp hạng:** active bid cao nhất luôn ưu tiên (pay-to-win); nếu **cùng mức bid, kể cả 0 bid**, ưu tiên chủ sản phẩm có **nhiều lượt giới thiệu thành công** hơn, rồi so **click/view hợp lệ** của sản phẩm; tiếp đó mới dùng quy tắc phá hòa ổn định. Referral, click, view **không được đưa sản phẩm có bid thấp vượt sản phẩm có bid cao**.
13. **Thanh toán hoa hồng rút:** xử lý **chuyển khoản thủ công vào ngày 01-10 hằng tháng** cho số dư đủ điều kiện. Grok Bot được lập danh sách/đối soát; không tự chuyển tiền hoặc đánh dấu đã trả khi chưa có bằng chứng giao dịch thực.

**Giả định chưa được chủ sản phẩm chốt:** thế nào là một referral thành công, 5% áp dụng cho giao dịch đầu hay nhiều giao dịch, thời gian chờ chống hoàn tiền, độ trễ/phương pháp lọc click/view và ngưỡng rút tối thiểu. Phần 5.4 đưa ra mặc định kỹ thuật an toàn dưới feature flags, bắt buộc trình owner duyệt trước khi live.

**Cách làm:** khảo sát repo trước, đề xuất kiến trúc tương thích repo, viết ADR cho những giả định còn mở, triển khai theo phase, test trước khi bật live. Không hỏi lại những quyết định đã được ghi ở trên.

---

## 1. Điều Lucky Boost bán và không bán

**Đang bán:** vị trí hiển thị cao hơn trong BXH tương ứng với số tiền bid đang hiệu lực. Top 10 **tại thời điểm khóa snapshot** nhận thêm một lần xuất hiện trong video tổng hợp được đăng lên các kênh chính thức. Toàn bộ bảng được phân phối thêm nhờ quỹ quảng cáo của bảng đó.

**Không bán và không bảo đảm:** số lượng impression cụ thể, lượt nhấp, chuyển đổi, doanh thu, việc giữ Top 10 đến phút khóa, một lượng ad spend riêng cho từng sản phẩm, hoặc đăng organic riêng cho người không lọt Top 10.

Quy tắc **pay-to-win** phải nổi bật tại màn hình báo giá, thanh toán, BXH, điều khoản và thông tin minh bạch quảng cáo. Không ngụ ý rằng thứ hạng là đánh giá chất lượng hay bình chọn khách quan.

**Định vị:** `Build in public. Bid to win.`; thông điệp 03:12 là điểm nhận diện thương hiệu gợi `BIP`.

### 1.1 Người dùng mục tiêu

- Builder, indie maker, startup, nhà phát triển phần mềm, chủ sản phẩm muốn giới thiệu sản phẩm.
- Người bán có AI agent hỗ trợ tạo nội dung, đăng trang và đấu giá.
- Người truy cập website/social khám phá sản phẩm.
- Một operator dùng Grok Bot tự động vận hành hệ thống.

### 1.2 Phạm vi MVP

**Có:** đăng/duyệt qua MCP; layout widgets; public pages; BXH ba bảng; bid liên tục; referral links và attribution; hoa hồng 5%; ví hoa hồng dùng để bid; yêu cầu rút tiền và xử lý chuyển khoản thủ công ngày 01-10; checkout PayPal/SePay; xác nhận webhook an toàn; snapshot 03:12; video Top 10 từ template; Zernio publication; ad flight planning và tracking; dashboard; audit log; Grok Bot orchestration; operator MCP có quyền riêng.

**Sau MVP:** bidding strategies phức tạp, API công khai cho bên thứ ba, nhiều operator, đấu giá theo khu vực/ngành, tối ưu chuyển đổi sâu, chương trình affiliate nhiều tầng hoặc lifetime, organic spotlight tự động quy mô lớn, thêm phương thức thanh toán.

---

## 2. Ngôn ngữ miền sản phẩm (domain model)

- `Product`: sản phẩm đã xác minh chủ sở hữu, có mô tả/địa chỉ đích, có thể free.
- `ProductPage`: bản render từ danh sách widgets có schema, không có JS tùy ý.
- `Board`: một trong `daily`, `weekly`, `monthly`.
- `BidIntent`: yêu cầu mua thêm một lượng bid được cố định theo quote và checkout.
- `BidContribution`: khoản bid đã thu thành công; có `starts_at`, `expires_at`, `amount_rank_units`, `budget_cohort_id`.
- `ActiveBid`: **tổng các BidContribution chưa hết hạn**, không phải tổng mọi khoản từng nộp trong lịch sử.
- `LiveLeaderboard`: thứ hạng hiện tại tính từ ActiveBid.
- `Snapshot`: danh sách theo thứ hạng được đóng dấu tại 03:12, **bất biến**.
- `RevenueCohort`: doanh thu **mới** xác nhận từ snapshot trước đến snapshot này cho một board, được phân bổ quảng cáo **đúng một lần**.
- `AdFlight`: một chiến dịch/phân bổ quảng cáo có thời gian 1/7/30 ngày và ngân sách có trần.
- `ContentAsset`: video, thumbnail, caption theo snapshot.
- `SocialPublication`: post/comment đăng lên social, URL và trạng thái.
- `Evidence`: số liệu API, ảnh chụp màn hình, dấu thời gian và nguồn.
- `DecisionLog`: đầu vào đã được làm sạch, hành động đề nghị, quyết định của Jev/TypeSafe, nguyên nhân, thực thi/kết quả.
- `ReferralAttribution`: liên kết người được giới thiệu với **một** người giới thiệu sau kiểm tra chống self-referral/sybil; có source và thời điểm.
- `SuccessfulReferral`: mỗi tài khoản được giới thiệu đủ điều kiện thành công **chỉ được tính một lần** vào `referral_success_count` của người giới thiệu; không phải tổng click referral hay số bid.
- `ReferralCommission`: hoa hồng 5% trên khoản doanh thu hợp lệ theo policy; trạng thái `pending / available / reserved / spent / payout_requested / paid / clawed_back` được dẫn xuất từ ledger, không phải số dư tùy ý.
- `CommissionWallet`: số dư hoa hồng thực sự còn khả dụng; có thể thanh toán toàn phần/một phần bid, hoặc yêu cầu rút bằng quy trình thủ công.
- `PayoutRequest` / `PayoutBatch`: yêu cầu rút, batch xử lý ngày 01-10, bằng chứng chuyển khoản, số tiền trả, trạng thái đối soát; **không** phải thanh toán tự động qua PayPal/SePay.

## 3. Luật bidding và hiệu lực theo thời gian

### 3.1 Quy tắc xác định thứ hạng

Với sản phẩm `p`, bảng `b`, thời điểm `t`:

```text
active_rank_amount(p,b,t) = SUM(contribution.rank_units)
  WHERE contribution.product_id = p
    AND contribution.board = b
    AND contribution.status = confirmed
    AND contribution.starts_at <= t
    AND contribution.expires_at > t

sort:
  1) active_rank_amount DESC                              # pay-to-win tuyệt đối
  2) owner_successful_referrals DESC                       # khi active bid bằng nhau, kể cả 0
  3) product_valid_unique_clicks_rolling_30d DESC          # khi active bid + referral bằng nhau
  4) product_valid_unique_views_rolling_30d DESC           # khi cả clicks cũng bằng nhau
  5) achieved_current_amount_at ASC, với active bid > 0    # hòa hoàn toàn thì ai đạt bid trước
  6) published_at DESC, sau đó product_id ASC              # tie-break cuối ổn định
```

- Sản phẩm có `active_rank_amount > 0` luôn đứng trước sản phẩm có `0`; referral và metrics **chỉ phá hòa khi cùng bid**, không phá luật pay-to-win.
- `owner_successful_referrals` là **số người được giới thiệu thành công, không trùng**, ghi theo chủ tài khoản và áp dụng cho sản phẩm của chủ đó. Không đếm nhiều giao dịch của một người là nhiều referrals.
- `clicks/views` dùng **số lượt hợp lệ đã lọc bot/tự nhấp**, không dùng raw counters hay số liệu do client tự khai. Mặc định đề xuất: ưu tiên unique product-card/outbound clicks, sau đó unique product views trong 30 ngày lăn; yêu cầu owner duyệt quy tắc trước go-live vì thứ tự này ảnh hưởng trực tiếp ranking.
- Nhóm miễn phí (`active_rank_amount = 0`) **vẫn** được xếp theo referrals, clicks, views theo cùng thuật toán; `published_at DESC` chỉ là tie-break cuối cùng.
- Metrics ranking có thể được kết xuất theo cửa sổ định kỳ và phát sự kiện thay hạng; không viết mỗi lần page view thành một transaction thay bảng. Snapshot 03:12 phải dùng rollup/scores đóng dấu theo cutoff, có version và audit.
- Top 10 bao gồm cả sản phẩm miễn phí nếu chưa đủ 10 sản phẩm trả tiền. Cần đủ điều kiện kiểm duyệt mới được lên hình.
- Mỗi board độc lập: bid Daily không tự cộng vào Weekly/Monthly.
- Có thể tăng bid nhiều lần. Mỗi khoản là **một contribution riêng**; các khoản cũ hết hiệu lực độc lập. Không kéo dài miễn phí thời gian của các khoản bid cũ khi nộp thêm.
- Mọi thay đổi thứ hạng qua bid/expiry được phát realtime qua SSE/WebSocket, có fallback polling.

### 3.2 Thời gian hiệu lực, quy tắc mặc định triển khai

Các thông số **chưa được người sáng lập xác nhận riêng** được chốt thành **giả định implementation có thể cấu hình**, ghi rõ trong UI và ADR trước khi live:

| Board | Hiệu lực một contribution | Flight quảng cáo tương ứng |
|---|---|---|
| `daily` | 24 giờ từ `confirmed_at` | 24 giờ sau snapshot nhận tiền |
| `weekly` | 7 × 24 giờ từ `confirmed_at` | 7 × 24 giờ |
| `monthly` | 30 × 24 giờ từ `confirmed_at` | 30 × 24 giờ |

`confirmed_at` là timestamp DB ghi nhận **đã xác thực và hoàn tất thanh toán**, không phải thời gian người dùng bắt đầu checkout, không phải thời điểm chỉ redirect thành công.

**Cần tránh hiểu nhầm:** quyền lợi video chỉ xét ở snapshot 03:12; payment hợp lệ lúc 03:13 có hiệu lực trên BXH live ngay, nhưng phải chờ snapshot 03:12 hôm sau để xét Top 10/video. Trước đó không tự tạo video mới.

**Quy tắc bid tối thiểu:** lưu trong server config (`MIN_BID_UNITS`, `MIN_BID_INCREMENT_UNITS`), dùng giá sandbox mặc định tương đương USD 1 để test; **giá production phải được duyệt**, không hardcode trong logic.

### 3.3 Khóa snapshot hằng ngày

- `cutoff_at`: 03:12:00, `Asia/Ho_Chi_Minh` mỗi ngày, chuyển sang UTC để lưu.
- Tất cả thanh toán **được xác nhận và commit vào DB trước cutoff** mới tính vào snapshot và RevenueCohort kỳ đó. Chỉ có payment provider báo đã trả trước cutoff nhưng webhook đến sau **không** được hồi tố thay đổi snapshot.
- Job có thể chạy muộn vì sự cố, nhưng phải dùng mốc cutoff đã định, không dùng giờ job khởi chạy. Ghi `actual_executed_at` riêng.
- Tạo **ba snapshot** daily/weekly/monthly, với unique `(board, cutoff_at)`, giữ nguyên lịch sử. Không thực hiện hai lần nếu job retry.
- Snapshot giữ `rank`, `product_id`, `active_rank_amount`, `owner_successful_referrals`, `valid_clicks`, `valid_views`, `ranking_metric_window`, `ranking_policy_version`, `page_version`, `product_metadata_version`; không thay kết quả đã công bố khi bid/referral/metrics mới tới.
- Trường hợp sản phẩm bị phát hiện vi phạm sau khóa: đánh dấu `removed_from_publication` kèm quyết định kiểm duyệt và lý do, **không sửa âm thầm lịch sử xếp hạng**. Video đang sản xuất có thể bỏ sản phẩm đó theo luật nội dung; phải ghi nhận ngoại lệ và không tùy tiện đẩy sản phẩm #11 lên thay như thể thứ hạng đã đổi.
- Khi job/mạng lỗi, retry có giới hạn, idempotent, báo operator; không tạo video/post/campaign trùng.

### 3.4 Ví dụ không đếm trùng

- `2026-11-08 03:11` người A trả thêm $100-equivalent ở Weekly; ActiveBid tăng $100 ngay.
- `2026-11-08 03:12` người A có thể lọt snapshot Weekly Top 10; **chỉ một lần** $100 này được ghi vào RevenueCohort Weekly ngày 08/11 và tạo quỹ Ads $80-equivalent.
- `2026-11-09 03:12` nếu contribution vẫn hiệu lực, A vẫn có thể xuất hiện trong Top 10 mới, nhưng $100 **không được cộng lại** vào quỹ Ads 09/11.
- Nếu 08/11 03:13 có thêm bid $20, khoản $20 được cộng vào cohort 09/11 khi đóng khóa; không bị bỏ sót.

---

## 4. Vòng đời thanh toán: PayPal + SePay, không Stripe/MoR

### 4.1 Các quyết định provider

**PayPal**

- Dùng PayPal Business merchant tại Việt Nam, kiểm tra tình trạng KYC và quyền merchant thực tế trước khi live.
- Dùng Checkout **Orders API v2**, tạo order/capture phía server; dùng PayPal JS SDK/approval URL phù hợp khi người mua chuyển sang checkout.
- Chỉ ghi `confirmed` khi capture thực sự hoàn tất, bao gồm xử lý webhook `PAYMENT.CAPTURE.COMPLETED`; tình trạng `PENDING`, `DENIED`, `REVERSED`, `REFUNDED` không được nhận là bid hợp lệ.
- Gọi API với `PayPal-Request-Id` ổn định cho từng thao tác có retry; xác minh webhook theo hướng dẫn PayPal, không tin payload thô hoặc redirect của browser.

**SePay**

- Ưu tiên **SePay Payment Gateway** với VietQR, đơn thanh toán một lần. Không xây recurring subscriptions.
- Phân biệt **SePay Payment Gateway IPN** với **SePay Bank Webhooks**: hai luồng có payload và cách xác thực khác nhau. MVP chỉ cần một loại mặc định, không trộn lẫn hai kiểu handler.
- Với Payment Gateway: sandbox `pgapi-sandbox.sepay.vn`, production `pgapi.sepay.vn`; thực hiện create-checkout / redirect theo tài liệu chính thức; xác thực IPN theo `Auth Type` được cài trong merchant dashboard (ví dụ `X-Secret-Key` nếu cấu hình tương ứng).
- Nếu chọn phương án tự dựng VietQR + bank transaction webhook: phải dùng transaction reference duy nhất, đối chiếu **số tiền + tài khoản nhận + hướng chuyển tiền vào + mã thanh toán**, xác thực HMAC trên raw body theo cấu hình, chống một giao dịch khớp nhiều đơn. Đây là phương án thay thế có ADR riêng, **không tự bật cả hai**.
- Không xác nhận thanh toán chỉ vì redirect tới `return_url`, QR được hiển thị hay người dùng gửi ảnh chụp giao dịch.

**Cấm:** Stripe, Paddle, Lemon Squeezy hay bất kỳ Merchant of Record nào làm đường thanh toán dự phòng; không thêm SDK, biến môi trường hoặc UI của các provider đó.

### 4.2 Checkout do agent khởi tạo, con người thanh toán

```text
User -> User Agent -> /mcp boosts.quote(product, board, increment)
  -> immutable BidIntent + PriceQuote (currency, expiry, FX, amount)
  -> /mcp boosts.checkout(intent_id, provider)
  -> returns secure hosted checkout URL / approval instructions
  -> user completes PayPal / SePay payment OR chooses available commission-wallet balance
  -> provider IPN/webhook -> signature/auth verify -> matching + reconciliation
     (or atomic wallet debit with no external provider call, including partial wallet + cash)
  -> DB TX: paid amount matched + 1 contribution + ledger entries + referral events + outbox event
  -> live rank changes -> MCP status / public leaderboard updates
```

`boosts.checkout` tuyệt đối **không** tự trừ tiền nếu người dùng chưa đồng ý với khoản chi. Với agent tự động bidding, mỗi thao tác phải nằm trong hạn mức user đã phê duyệt; vẫn dùng luồng thanh toán được provider cho phép. MVP không lưu thẻ và không tự giả mạo thao tác xác nhận thanh toán của người dùng.

### 4.3 Các bất biến tài chính

- Tiền là **integer minor units**, tránh float; `VND` không có phần thập phân, `USD` dùng cents. Mọi chuyển đổi tiền tệ có `fx_rate`, `fx_source`, `quoted_at`, `quote_expires_at` và rounding rule đã lưu.
- BXH cần một đơn vị so sánh chung. Dùng `rank_units` (fixed-point USD-equivalent tại **tỷ giá khóa trong quote**, không cập nhật lịch sử theo tỷ giá thị trường). Giao diện hiển thị giá trị bid chuẩn hóa và số tiền thanh toán thực tế bằng đơn vị tiền tương ứng.
- Tỷ giá định giá và quy tắc làm tròn phải công khai; không lấy tỷ giá do client đưa lên. Quote có TTL; khi hết hạn phải quote lại.
- Ràng buộc dữ liệu `provider_payment_id UNIQUE`, `bid_intent_id UNIQUE` cho payment đã thành công, `provider_event_id UNIQUE` và idempotency key per operation; webhook có thể bị replay/out-of-order.
- **Một khoản thanh toán bid = tối đa một BidContribution và một khoản doanh thu được phân bổ**. Ghi ledger và contribution trong cùng DB transaction, sau xác thực provider; bid thanh toán qua ví hoa hồng cũng phải có nguồn tiền sẵn có, sự kiện settlement duy nhất và accounting riêng, không giả làm PayPal/SePay webhook.
- Giao dịch giới thiệu thành công tạo `ReferralCommission` tối đa một lần theo đơn hàng đủ điều kiện; refund/chargeback có thể tạo clawback/hold, không được trả hoa hồng hai lần.
- Không cho phép hoàn tiền vì bị outbid; có ngoại lệ cho thanh toán lỗi, giao dịch trùng, fraud, luật bắt buộc hoặc lỗi vận hành được chứng minh. Với chargeback/refund, ghi ledger bù trừ, vô hiệu hóa contribution tương ứng theo policy, đối soát quỹ Ads.
- Chi phí quảng cáo đã phát sinh không thể thu hồi khi chargeback; cần quỹ dự phòng vận hành, khả năng tạm dừng spending, và quy trình xử lý thiếu hụt. Không để số dư quỹ âm dẫn đến agent tiếp tục tiêu tiền.
- Người mua phải nhìn thấy *all-pay, no guarantee of Top 10, no guarantee of results* trước khi thanh toán.

### 4.4 Trạng thái chuẩn

```text
BidIntent:  created -> quoted -> awaiting_payment -> confirmed
                                |                   |-> refunded / disputed
                                |-> expired / failed / cancelled
Payment:    created -> pending -> captured -> settled
                              |-> denied / reversed / refunded / disputed
Contribution: inactive -> active -> expired
                                 |-> suspended / voided_after_refund
```

Không xem trạng thái `approved` hoặc `pending` của payment là hoàn tất. Nếu provider status mơ hồ, chạy reconciliation, không cấp bid tạm.

---

## 5. RevenueCohort và phân bổ 80% quảng cáo

### 5.1 Cách lập sổ

Với từng board `b` và cutoff `c`:

```text
cohort(b,c) = SUM(eligible confirmed bid payments assigned to (b,c))
           + approved signed financial adjustments

advertising_fund(b,c) = floor_to_minor_units(0.80 * eligible_revenue(b,c))
referral_commission_fund(b,c) = SUM(0.05 * eligible_commission_base_of_qualifying_sales)
operator_allocation(b,c) = eligible_revenue(b,c)
                          - advertising_fund(b,c) - referral_commission_fund(b,c)
# Nếu không có qualifying referral: commission = 0, operator tối đa 20%.
# Nếu toàn bộ doanh thu đủ điều kiện trả commission 5%: operator còn ~15% trước chi phí.
```

**Giả định kế toán cần công bố trước live:** `eligible_revenue` là doanh thu bid thu thành công **sau khoản hoàn/hủy và thuế thu hộ nếu có**, không cộng tiền chưa nhận; phí processing/FX vận hành nằm trong phần 20% trừ khi có quyết định thương mại mới. Nếu ý định là 80% doanh thu gộp chưa loại trừ khoản nào, phải cập nhật ADR và UI trước khi thu tiền. Không được âm thầm đổi tỷ lệ.

Lập ba quỹ quảng cáo hoàn toàn tách biệt. **Không lấy doanh thu của board này chi cho board khác.** Không cho AI đổi tỷ lệ 80% quảng cáo hoặc 5% commission theo policy đã công bố. **Phần giữ lại của nền tảng không mặc định là 20% nữa**: với doanh thu có referral đủ điều kiện, công thức tham khảo là 80% quảng cáo + 5% hoa hồng + 15% nền tảng (trước phí và chi phí). Không có referral đủ điều kiện thì nền tảng giữ phần 20% còn lại. Commission phải là khoản phải trả được bảo chứng bằng tiền thực, không chi từ quỹ Ads.

**Commission wallet khi dùng để bid:** chuyển số dư phải trả của người giới thiệu sang nguồn thanh toán cho BidIntent **một lần, bằng bút toán cân đối**. Khi khoản đó trở thành bid hợp lệ, hệ thống phân bổ quỹ Ads mới từ giá trị bid bằng ví theo policy, **không** tạo thêm tiền mặt ảo, không tính khoản ví đã chuyển như một lần nhận tiền ngoài hệ thống mới. Báo cáo tài chính phân biệt `external_cash_received`, `wallet_funded_bid`, `eligible_bid_volume`, `ads_committed`, `commission_liability`. Mặc định không trả thêm referral commission trên phần bid được tài trợ bằng ví để tránh vòng lặp tự thưởng; cần ADR trước live.

### 5.2 Ghi nhận đóng góp vào cohort đúng một lần

- Mỗi confirmed contribution gắn `assigned_cutoff` = **cutoff 03:12 kế tiếp sau khi DB xác nhận thanh toán**.
- `UNIQUE(contribution_id, allocation_type)` ngăn cộng tiền nhiều lần.
- `RevenueCohort` có trạng thái `open -> finalized -> funded -> closed`, ledger append-only.
- Hoàn tiền/chargeback **sau khi khóa** được xử lý bằng adjustment/corrective ledger ở thời điểm hiện tại, **không sửa lịch sử snapshot hay âm thầm xóa chi tiêu cũ**.
- Nếu cohort không có doanh thu mới: tạo snapshot + organic video theo cấu hình, nhưng **ad budget mới bằng 0**. Không tạo Ads campaign mới với ngân sách lấy từ bid cũ.

### 5.3 Lịch rải ngân sách

| Board | Thời gian rải ngân sách cohort mới | Ngân sách nền/ngày |
|---|---:|---:|
| Daily | 24 giờ | `fund / 1` |
| Weekly | 7 × 24 giờ | `fund / 7` |
| Monthly | 30 × 24 giờ | `fund / 30` |

- Mỗi ngày có 3 cohorts mới; các weekly/monthly flights từ những ngày trước có thể vẫn hoạt động.
- Ở trạng thái có đủ số ngày phát sinh, có tối đa khoảng **1 Daily + 7 Weekly + 30 Monthly = 38 flights theo cohort**; số chiến dịch thực tế có thể lớn hơn nếu một flight tách ra nhiều kênh.
- Grok Bot chọn kênh Meta, X, YouTube/Google, TikTok, OpenAI theo dữ liệu và chính sách tài khoản; **không bắt buộc chia đều**; mỗi kênh có mức tối thiểu và giới hạn chi tiêu được kiểm tra bởi adapter.
- Bộ điều phối chỉ cấp `spend_cap`; Grok Bot có thể đề xuất `allocation(channel, amount)` sao cho tổng theo flight và theo board không vượt quỹ đã duyệt. Khi nền tảng quảng cáo báo spend chậm, sử dụng buffer an toàn và cấm cấp vượt hạn mức.
- Tiền ghi nhận `planned`, `committed`, `spent`, `reconciled`, `remaining` riêng. Đừng đồng nhất số tiền đặt ngân sách với chi phí thực tế.
- Nếu không đủ tiền cho minimum spend, dồn ngân sách trong flight để chạy khi đủ, hoặc giữ `unallocated` chờ phân bổ theo điều khoản đã công bố; không dùng quỹ khác bù.
- Cuối kỳ phải có report chi tiêu thực, chưa chi, nguyên nhân; xử lý tiền chưa dùng theo chính sách công khai và nghĩa vụ dịch vụ, **không tự động chuyển thành doanh thu operator**.


### 5.4 Chương trình giới thiệu: commission 5%, ranking và rút tiền

**Quyết định đã chốt (không tự thay đổi):**

1. Mỗi lượt giới thiệu thành công có **hoa hồng 5%** trên cơ sở tính hoa hồng đủ điều kiện.
2. Chủ tài khoản có **nhiều lượt giới thiệu thành công hơn** được ưu tiên trong trường hợp **bid bằng nhau** (kể cả 0 bid). Nếu referrals cũng bằng nhau, **click/view hợp lệ** cao hơn xếp trên.
3. Hoa hồng có thể **dùng để bid sản phẩm** hoặc **yêu cầu rút**. Lệnh rút được **chuyển khoản thủ công trong ngày 01-10 hằng tháng**, không phải gửi ngay khi bấm rút.
4. Các điều kiện này không thay đổi **all-pay**: bid trả bằng commission wallet cũng không hoàn lại chỉ vì bị vượt hạng.

**Giả định MVP cần ADR, owner duyệt trước khi live (không giả vờ là quyết định đã chốt):**

| Vấn đề chưa chốt | Mặc định đề xuất để coding agent triển khai/test | Vì sao |
|---|---|---|
| `successful referral` | Một người được giới thiệu là tài khoản thực, khác người giới thiệu, có **lần mua bid đầu tiên bằng tiền ngoài hệ thống đã được xác nhận**, vượt qua kiểm tra gian lận và thời gian giữ hoa hồng | Chống tạo tài khoản ảo, self-referral và đếm nhiều lần |
| Phạm vi 5% | **5% trên phần đủ điều kiện của giao dịch đầu tiên** của người được giới thiệu; **không mặc định lifetime commission** | Người dùng chưa chốt 5% cho giao dịch đầu hay mọi giao dịch; cần tránh tạo nghĩa vụ vô hạn |
| Ngày xác nhận hoa hồng | `pending -> available` sau thời gian giữ cấu hình (gợi ý sandbox 30 ngày), không có hoàn/hủy/tranh chấp chưa giải quyết | Hạn chế trả ra tiền rồi gặp chargeback |
| Attribution | Mỗi referred account có **một** referrer; signed referral link/code, thời hạn attribution có cấu hình (gợi ý 30 ngày) và ghi immutable khi đủ điều kiện | Chống giành công và thay referrer sau khi mua |
| Số liệu phá hòa | Unique clicks ưu tiên trước unique views; cửa sổ 30 ngày lăn; lọc bot và tự tạo traffic | Ngăn click/view giả, tránh ưu tiên số liệu thô |
| Rút tiền | Chỉ `available balance`; có minimum payout cấu hình, xác minh chủ tài khoản, thông tin nhận tiền và nghĩa vụ thuế tùy thị trường | Tránh gửi tiền nhầm và các khoản thanh toán quá nhỏ |

**Không được tính `registered user` hay `referral link click` là giới thiệu thành công.** Số lượt thành công là **số tài khoản khác nhau**, không phải số lần mua hoặc số sản phẩm; hiển thị trên mọi sản phẩm thuộc người giới thiệu. Nếu user sau này quyết định 5% cho mọi bid từ referred users, cập nhật policy version + tài chính + acceptance tests trước khi kích hoạt, **không sửa ngầm**.

**Quy trình commission:**

```text
referral code/link -> referred account -> attribution recorded
  -> referred user completes qualifying external-cash bid
  -> provider confirmed + anti-fraud checks + hold period
  -> SuccessfulReferral (counted once per referred user)
  -> ReferralCommission earned (5% of eligible first-bid base, under MVP assumption)
  -> wallet AVAILABLE
      |-> use_for_bid -> reserved -> settled/consumed in exactly-one bid
      |-> request_payout -> payout_requested -> operator payout batch (01-10)
                                    -> manual bank transfer with proof -> paid
```

**Commission wallet phải hỗ trợ:**

- Sổ cái immutable/double-entry, số dư `pending`, `available`, `reserved_for_bid`, `reserved_for_payout`, `paid`, `clawed_back`; **không để số dư âm khả dụng**.
- Bid toàn bộ bằng ví, một phần ví + một phần PayPal/SePay, hoặc hoàn toàn bằng PayPal/SePay. Phải **reserve wallet trước**, chỉ `consume` khi phần còn lại được thanh toán thành công; timeout/cancel phải giải phóng reserve đúng một lần.
- Nếu ví đủ chi, không bắt gọi PayPal/SePay cho khoản $0; tạo internal settlement idempotent. Nếu ví không đủ và provider thanh toán thất bại, không tăng rank, không tiêu tiền ví.
- `SuccessfulReferral` không được bị nhân đôi qua nhiều lần bid từ cùng người được giới thiệu; mọi khoản clawback giữ lịch sử và tác động tới commission balance/referral score theo policy được version hóa.
- Không được chuyển hoa hồng giữa hai người dùng theo lệnh của agent; không hỗ trợ chuyển ví P2P.

**Lịch rút thủ công:**

- Người dùng gửi yêu cầu rút; hệ thống chốt tập số dư khả dụng và khóa tương ứng, không cho vừa yêu cầu rút vừa dùng tiền đó để bid.
- Grok Bot chuẩn bị `PayoutBatch` và danh sách đối soát; **người vận hành thực hiện chuyển khoản thủ công ngày 01-10 hằng tháng**. Chỉ chuyển tiền sau khi kiểm tra người thụ hưởng, số tiền và vấn đề thuế/KYC nếu có.
- Operator nhập `bank_transfer_reference`, số tiền thực chuyển, thời điểm và bằng chứng; chỉ khi đối soát thành công mới đổi trạng thái `paid`. Thất bại thì giữ `pending/failed`, trả lại ví khi được phép. Không đánh dấu `paid` chỉ vì Grok Bot bấm nút.
- Lịch là **cửa sổ xử lý ngày 01-10**, không tự cam kết mọi yêu cầu gửi sát ngày 10 sẽ được thanh toán ngay. Cần công bố cutoff xét duyệt batch, mức rút tối thiểu và điều khoản thuế trước live.

**Chống gian lận:** không tự giới thiệu; không tính các tài khoản/sản phẩm trùng chủ có dấu hiệu sybil; chống referral code injection, referral hopping, click farm, bot traffic và purchase-refund cycling. Grok Bot xét duyệt trường hợp nghi vấn qua Jev/TypeSafe, có log và cơ chế khiếu nại; quyền ghi ledger và thay đổi kết quả chỉ qua các transaction được kiểm soát.

---

## 6. Product page và website

### 6.1 Public routes đề xuất

```text
/                        homepage, tabs Daily / Weekly / Monthly
/daily                   live leaderboard Daily
/weekly                  live leaderboard Weekly
/monthly                 live leaderboard Monthly
/p/{slug}                product page từ widgets
/s/{board}/{yyyy-mm-dd}  immutable daily snapshot của board
/checkout/{intent_id}    hosted user-approved checkout step
/account                 account info, payments, owned products (read-only editing on web)
/account/referrals       link/code, số lượt giới thiệu thành công, commission statement
/account/wallet          số dư hoa hồng, lịch sử credit/debit, dùng ví khi checkout
/account/payouts         yêu cầu rút, thông tin thụ hưởng và tình trạng chuyển khoản
/r/{referral_code}       liên kết giới thiệu được ký/xác thực, chống open redirect
/transparency             public spend/analytics/evidence overview
/mcp                     user-facing MCP Streamable HTTP
/operator/mcp            operator-only MCP, riêng auth/scopes
/api/webhooks/paypal      PayPal verified webhook
/api/webhooks/sepay       SePay Payment Gateway IPN hoặc Bank Webhook theo adapter chọn
```

Các URL chỉ là gợi ý route; tên triển khai có thể đổi nếu repo đã có conventions, nhưng hợp đồng tương đương phải được giữ và kiểm thử.

### 6.2 Widgets được phép

Tối thiểu: `hero`, `gallery`, `video`, `feature_grid`, `rich_text`, `call_to_action`, `pricing`, `testimonials`, `faq`, `founder_note`, `links`, `metrics`.

- Agent gửi JSON schema versioned, thứ tự blocks, params; server validate bằng TypeSafe/Zod/JSON Schema, trả preview URL và lỗi có thể sửa.
- Cho phép theme tokens/branding hạn chế; **cấm raw HTML, inline JS, script, iframe không kiểm soát**, CSS injection, data URL độc hại, remote redirects ngoài policy.
- Ảnh/video dùng URL đã xác minh hoặc upload pipeline an toàn; kiểm MIME/type/size/SSRF, chặn truy cập private IP/metadata endpoint khi crawler fetch.
- Mọi phiên bản page có `page_version`, `moderation_state`, `published_at`; snapshot tham chiếu version cụ thể.
- Product được Grok Bot/decision layer kiểm duyệt theo policy; nội dung user không được coi là chỉ thị hệ thống.

### 6.3 Hệ thống impression/click chống gian lận

Các metric riêng biệt:

1. `listing_visit`: lượt mở listing page (có session/visitor dedup).
2. `product_card_impression`: card thực sự nằm trong viewport đủ ngưỡng nhìn đã định, không tính fetch/SSR.
3. `product_page_view`: xem trang sản phẩm.
4. `product_card_click`: click từ listing sang trang sản phẩm.
5. `outbound_click`: click ra website sản phẩm với redirect/interstitial hoặc signed tracking URL.
6. `social_post_impression / view / click`: chỉ số do Zernio/nền tảng cung cấp, ghi rõ source và freshness.
7. `ad_spend`, `CPM`, `CPC`, `CTR`: lấy từ provider/Zernio, phân biệt với click trên website.
8. `rank_position_minutes`, `time_in_top10`: thời gian giữ vị trí theo rank history, có hạn mức lưu trữ.

Không gộp `impressions` quảng cáo với `product card impressions`, không tự suy ra một video view là một impression cho cả 10 sản phẩm. Phân biệt raw/filtered bot traffic; không cam kết chất lượng nếu chưa đo được.

**Chỉ số được dùng để phá hòa thứ hạng:** đọc từ `ranking_metric_rollups` versioned (unique filtered product clicks/views trong rolling 30 ngày theo giả định MVP), không đọc trực tiếp từ số liệu raw tự khai hay từ Ads API. Cần chống click/view do chủ sản phẩm tự tạo và phát hiện tăng trưởng bất thường. Phải có đối chiếu score tại cutoff 03:12 để tái lập bảng snapshot một cách xác định.

---

## 7. Grok Bot và operator automation

### 7.1 Nguyên tắc

Grok Bot là **operator chính**, được cấp Cloud Desktop/Browser đã đăng nhập các tài khoản vận hành, đồng thời dùng Zernio MCP, API và CLI. Ưu tiên **API/CLI** cho các thao tác có thể xác định chính xác, lặp lại; Browser dùng để thiết lập, tác vụ thiếu API, QA, chụp màn hình và xử lý ngoại lệ.

Có thể tự động hóa toàn bộ luồng thường nhật. Khi phát hiện sự cố không chắc chắn, **tạm dừng hành động có rủi ro, giữ quỹ và phát cảnh báo**, không bắt buộc có người duyệt mọi nghiệp vụ bình thường. Owner có thể khôi phục khi cần.

### 7.2 Workflow mỗi ngày

```text
03:12 scheduled event
  -> freeze boards (deterministic, transactional)
  -> finalize three new revenue cohorts
  -> enqueue 3 SnapshotPublished events
  -> Grok Bot quality checks + classify products
  -> generate motion videos using snapshot product assets
  -> QA videos: identity/logo/link order/caption/video specs
  -> publish via Zernio API/CLI/MCP to X/Facebook/YouTube
  -> publish first/pinned comment with top-10 links where supported
  -> for unsupported post/comment types, use documented API or authorized browser route
  -> create ad plans per cohort, validate budget caps
  -> launch supported campaigns and persist platform IDs
  -> hourly collect analytics + evidence screenshot, annotate freshness
  -> inspect suspected referral/click fraud, hold commissions via audited decisions
  -> prepare monthly commission payout batch; transfer itself remains manual
  -> allocate/optimize within hard caps, reconcile end-of-flight
  -> publish public audit/performance summary
```

**Vì YouTube Shorts không cho người xem click URL thông thường trong comments/description**, luôn thêm URL snapshot ngắn, dễ đọc trong video, và dùng bề mặt liên kết được hỗ trợ. Không cam kết người xem bấm được comment trên mọi nền tảng.

### 7.3 Zernio adapters

- `social.publishVideo(snapshot, platform, media, caption)`
- `social.postOrPinComment(publication_id, urls)`
- `social.getPostAnalytics(id)`
- `ads.createCampaign(flight, channel, objective, targeting)`
- `ads.updateBudget(campaign_id, cap)`
- `ads.pause(campaign_id)`
- `ads.getSpend(campaign_id)`
- `ads.getMetrics(campaign_id)`

Zernio có Ads API quảng bá trên Meta, Google, X, TikTok, LinkedIn, Pinterest, OpenAI; năng lực cụ thể phụ thuộc tài khoản đã kết nối, quyền được cấp và policy. **Không giả định mọi channel/account đều sẵn sàng.**

- Kiểm tra hoạt động `firstComment` trên YouTube khi tạo post. Với X/Facebook kiểm thử khả năng comment/pin theo API/CLI; khi không hỗ trợ, fallback browser có kiểm soát hoặc đưa link trong post/snapshot phù hợp.
- Gọi Zernio qua adapter để dễ đổi giữa MCP/API/CLI mà không làm hỏng domain logic.
- Mọi lời gọi publish/create campaign phải có application-level idempotency, job deduplication và kiểm tra external ID trước retry. Không tạo 2 ads chỉ vì request timeout.
- Nếu gặp giới hạn API, Ads policy hoặc UI Automation policy: chuyển trạng thái `blocked_by_platform`, không cố né kiểm soát hoặc đăng lặp.

### 7.4 Jev/TypeSafe + ranh giới bảo mật

**Decision layer** kiểm tra kiểu dữ liệu, scope, nguồn dữ liệu không đáng tin, policy nội dung và rủi ro hành động; xuất bản quyết định có schema:

```json
{
  "action": "ads.update_budget",
  "decision": "allow | deny | defer",
  "reason_codes": ["WITHIN_FLIGHT_CAP"],
  "policy_version": "v1",
  "resource_id": "flight_...",
  "requested_by": "operator:grok",
  "proposed_amount_minor": 0
}
```

- Product content, web pages, social comments, screenshots và tool outputs đều là **untrusted input**; không được đưa nội dung này lên cấp system/privileged instructions.
- Tách `operator/mcp` khỏi `/mcp` bằng identity, scopes, secrets, network rules. Agent người dùng không được gọi operator tools.
- Tool thực thi Ads phải có **server-side** spend ceilings và allowlist ad accounts. Không trông chờ vào lời nhắc trong prompt/Jev để chặn tiêu vượt quỹ.
- Secrets đặt trong vault/secret manager, token tối thiểu quyền; không trả raw credentials cho user-agent và không ghi vào logs/screenshot.
- Browser có phiên đăng nhập phải bị ràng buộc bởi allowlist/domain, tài khoản chuyên dụng, browser profile riêng và policy chống truy cập ngoài mục tiêu.
- Cần `kill switch` tạm ngừng social publishing/ads spending, riêng biệt với việc xem website và nhận webhook.
- Trường hợp nghi scam: Grok Bot có thể `approve/reject/suspend` dựa policy; mọi quyết định có reason code, log, khả năng khiếu nại; không được tự ý xóa evidence.

---

## 8. Dữ liệu và kiến trúc tham chiếu

**Nguyên tắc:** reuse codebase và infra sẵn có nếu phù hợp. Nếu dự án greenfield: ưu tiên TypeScript, relational DB có transaction/unique constraints, backend server có webhook raw-body verification, scheduler bền vững, queue/outbox, object storage cho media, frontend SSR. Không bắt buộc thêm microservices/Kafka/đa agent orchestration nếu một modular monolith đã đủ.

### 8.1 Logical components

```text
Public Web + User MCP + Operator MCP
          |
          v
API / Auth / Policy Gate
          |
          +-- Products / Page Builder / Moderation
          +-- Bidding / Live Ranking / Snapshots
          +-- Payments: PayPalAdapter + SePayAdapter + CommissionWalletSettlement
          +-- Referrals / Attribution / Commission / Manual Payouts
          +-- Finance Ledger / Revenue Cohorts / Ad Budgets
          +-- Analytics / Evidence
          +-- Operator Orchestrator + ZernioAdapter + BrowserAdapter
          |
          v
Relational DB + Transactional Outbox + Queue + Object Storage
```

### 8.2 Bảng dữ liệu tối thiểu

```text
users(id, email?, created_at, status)
referral_codes(id, referrer_user_id, code, status, created_at)
referral_attributions(id, referred_user_id, referrer_user_id, referral_code_id,
                      attribution_source, attributed_at, status)
successful_referrals(id, attribution_id, first_qualifying_bid_intent_id,
                     qualified_at, vested_at, status, policy_version)
referral_commissions(id, successful_referral_id, qualifying_bid_intent_id,
                     currency, eligible_base_minor, commission_minor, state, policy_version)
commission_wallet_accounts(id, user_id, currency, status)
wallet_reservations(id, wallet_account_id, bid_intent_id?, payout_request_id?,
                    reserved_minor, state, idempotency_key, created_at)
payout_requests(id, user_id, currency, requested_minor, approved_minor, state,
                payout_method, beneficiary_reference, requested_at)
payout_batches(id, window_month, status, prepared_at, transfer_started_at, reconciled_at)
payout_transfers(id, payout_batch_id, payout_request_id, currency, amount_minor,
                 bank_transfer_reference, proof_id, transferred_at, reconciled_at, status)
ranking_metric_rollups(id, product_id, window_start, window_end,
                       valid_unique_clicks, valid_unique_views, filter_version, as_of_at)
agent_connections(id, user_id, client_id, scopes, status)
products(id, owner_id, slug, website_url, status, published_at, created_at)
product_page_versions(id, product_id, schema_version, blocks_json, theme_json, moderation_status, created_at)
boards(code, active_duration_seconds, flight_duration_seconds, enabled)
bid_intents(id, product_id, owner_id, board, increment_rank_units, quote_currency,
            quote_minor, fx_rate, quote_expires_at, status, idempotency_key, created_at)
payments(id, bid_intent_id, provider, provider_payment_id, provider_event_id,
         currency, amount_minor, state, confirmed_at, created_at)
bid_contributions(id, bid_intent_id, product_id, board, rank_units,
                  starts_at, expires_at, assigned_cutoff_at, status, created_at)
ledger_entries(id, account_id, cohort_id?, currency, debit_minor, credit_minor,
               reference_type, reference_id, created_at)
board_snapshots(id, board, cutoff_at, executed_at, snapshot_version, status)
board_snapshot_items(id, snapshot_id, rank, product_id, page_version_id, rank_units,
                     owner_successful_referrals, valid_unique_clicks, valid_unique_views,
                     ranking_policy_version, visibility_state)
revenue_cohorts(id, board, cutoff_at, eligible_revenue_minor, currency, ads_fund_minor,
                referral_commission_minor, operator_allocation_minor, status)
revenue_cohort_contributions(id, revenue_cohort_id, bid_contribution_id, allocated_amount_minor)
ad_flights(id, cohort_id, start_at, end_at, spend_cap_minor, planned_minor,
           committed_minor, spent_minor, state)
ad_campaigns(id, flight_id, platform, external_campaign_id, spend_cap_minor, state)
content_assets(id, snapshot_id, type, url, content_hash, status)
social_publications(id, snapshot_id, platform, external_post_id, url, state)
measurement_events(id, product_id?, board?, snapshot_id?, event_type, session_key?,
                   source, occurred_at, metadata_json)
analytics_rollups(id, period, board, product_id?, platform?, metrics_json, source, as_of_at)
evidence(id, source, related_type, related_id, screenshot_url?, payload_hash?, captured_at)
decision_logs(id, actor_id, action, decision, reason_codes_json, policy_version,
              input_hash, result_json, created_at)
webhook_events(id, provider, event_id, signature_verified, processed_at, status)
outbox_events(id, event_type, aggregate_id, payload_json, status, created_at)
```

**Quan trọng:** schema trên là logical model, không phải SQL migration để copy nguyên xi. Thiết kế **double-entry ledger** thực sự phải balance theo từng đơn vị tiền tệ và quy tắc quy đổi; `ledger_entries` chỉ minh họa. Với 2 provider/currency, phải có FX accounting rõ ràng cho quảng cáo USD.

**Các unique constraints bắt buộc:** `(board, cutoff_at)` cho snapshot/cohort; `provider + provider_payment_id`; `(provider, event_id)`; `bid_intent_id` unique khi captured; `(cohort_id, bid_contribution_id)`; `referred_user_id` duy nhất cho referral attribution; `attribution_id` duy nhất cho successful referral; `(successful_referral_id, qualifying_bid_intent_id, policy_version)` cho commission (theo policy áp dụng); `wallet_reservation.idempotency_key` unique; `(payout_request_id, successful_transfer_reference)` chống trả trùng; `external_campaign_id + platform` (khi có); job idempotency `(job_type, resource_id, version)`.

**Schema payout transfer:** `bank_transfer_reference` phải unique theo ngân hàng/tài khoản gửi khi có dữ liệu đủ tin cậy; `proof_id` chỉ lưu tham chiếu bằng chứng riêng tư, không phát tán ảnh giao dịch. `ranking_metric_rollups` và referral counts phải có lịch sử để tái dựng score tại 03:12. Payout beneficiary chứa PII phải được mã hóa và phân quyền, không log raw.

### 8.3 Event / queue

```text
ProductSubmitted
ProductApproved / ProductRejected
PaymentConfirmed
ReferralAttributed / ReferralQualified / ReferralVested / ReferralClawedBack
CommissionAccrued / CommissionAvailable / CommissionSpentForBid
PayoutRequested / PayoutBatchPrepared / PayoutTransferReconciled
RankingMetricsUpdated
ContributionActivated / ContributionExpired
BoardSnapshotFrozen
RevenueCohortFinalized
VideoRenderRequested / VideoReady / VideoRejected
SocialPublishRequested / SocialPublished / SocialFailed
AdPlanRequested / AdCampaignCreated / AdCampaignPaused
AnalyticsCollected / EvidenceCaptured
RefundRecorded / ChargebackRecorded
OperatorActionDenied / OperatorInterventionRequired
```

- Luôn dùng DB transaction + outbox để không mất sự kiện sau khi thu tiền.
- Có dead-letter queue, retry exponential backoff, timeout và correlation ID.
- Bảo toàn thứ tự các chuyển trạng thái payment/ledger/bid theo khóa nghiệp vụ.

---

## 9. MCP contract (user + operator)

### 9.1 User endpoint `https://bip.ad/mcp`

Dùng MCP Streamable HTTP và OAuth với Protected Resource Metadata, token audience/resource binding; hỗ trợ phiên bản protocol phù hợp với client mục tiêu (ChatGPT/Claude). Không tự invent custom MCP protocol.

| Tool | Ý nghĩa | Có tác dụng đổi dữ liệu? |
|---|---|---|
| `products.create` | Tạo draft sản phẩm, gắn chủ sở hữu | Có |
| `products.update` | Sửa draft/sản phẩm thuộc quyền | Có |
| `products.submit` | Yêu cầu kiểm duyệt và xuất bản | Có |
| `products.get` / `products.list` | Xem sản phẩm | Không |
| `pages.set_blocks` | Lưu trang bằng widget schema | Có |
| `pages.preview` | Lấy preview URL + validation issues | Không |
| `pages.publish` | Publish bản page được duyệt | Có |
| `boards.get` | Xem BXH live, countdown, cutoff | Không |
| `boosts.quote` | Báo giá increment, vị trí dự kiến, điều khoản, expiry | Không tạo bid |
| `boosts.checkout` | Tạo checkout từ quote, người mua xác nhận | Tạo intent/order, **chưa** tăng rank |
| `boosts.status` | Xem payment + contribution + vị trí + expiry | Không |
| `referrals.get_link` | Lấy referral link/code của người dùng | Không (hoặc idempotent create nếu chưa có) |
| `referrals.stats` | Xem referral pending/successful và commission | Không |
| `wallet.balance` | Số dư hoa hồng pending/available/reserved | Không |
| `wallet.apply_to_bid` | Chọn khoản ví được dùng cho BidIntent, có reserve/idempotency | Có (không tự tạo bid thành công) |
| `payouts.request` | Yêu cầu rút hoa hồng đủ điều kiện, reserve số tiền | Có |
| `payouts.status` | Xem yêu cầu rút và chứng từ thanh toán đã đối soát | Không |
| `analytics.product` | Thống kê views/clicks/rank/exposure của sản phẩm | Không |

Các tool gọi nhầm tenant/product phải trả `403`, không tiết lộ dữ liệu của chủ khác. Các tool ghi có `idempotency_key`, `resource_version` hoặc optimistic concurrency.

### 9.2 Operator endpoint `https://bip.ad/operator/mcp`

`products.moderate`, `referrals.review`, `commissions.reconcile`, `payouts.prepare_batch`, `payouts.record_manual_transfer`, `boards.freeze`, `finance.reconcile`, `cohorts.finalize`, `videos.render`, `videos.qa`, `social.publish`, `social.comment`, `ads.plan`, `ads.execute`, `ads.optimize`, `ads.pause`, `analytics.collect`, `evidence.capture`, `operator.decisions`, `operator.health`.

Tool `boards.freeze` yêu cầu mốc cutoff cụ thể, trả idempotent result; tool `finance.reconcile` **không** được phép sửa payment balance tùy ý mà phải tạo adjustment có audit.

Operator identity không dùng token người dùng; mọi hành động ghi log actor + policy decision + external job IDs.

---

## 10. Điều khoản, kiểm duyệt và chính sách nền tảng

**Vận hành AI-first**, nhưng phải đáp ứng các giới hạn kỹ thuật và pháp lý:

1. Chính sách xuất hiện trả phí và pay-to-win công khai, không gắn nhãn "Top quality" hoặc hàm ý xếp hạng khách quan.
2. All-pay và điều kiện không hoàn tiền phải xuất hiện trước lúc thanh toán, với ngoại lệ bắt buộc theo luật/nhà cung cấp thanh toán.
3. Kiểm duyệt spam, scam, nội dung bị cấm, quyền sở hữu hình/logo/nhãn hiệu, link phishing/malware và tính trung thực lời quảng cáo. Grok Bot ra quyết định theo policy versioned, có bằng chứng và cơ chế khiếu nại.
4. Kiểm tra điều khoản merchant của **PayPal và SePay cho chính mô hình paid placement/all-pay** trước khi bật live. Việc PayPal Business có tại VN không đồng nghĩa merchant chắc chắn được phê duyệt hoạt động này.
5. Nội dung organic và quảng cáo phải tuân thủ quy định disclosure/ads policy của từng platform và các thị trường phục vụ; chưa phát hành nếu không qua được eligibility/brand safety.
6. Cơ chế đấu giá trả tiền để hiển thị không được mô tả thành trò may rủi nhận giải thưởng. Không phát hành random prize/gambling features.
7. Bảo vệ thông tin cá nhân, không công khai PayPal payer ID, số tài khoản ngân hàng hay địa chỉ email trong transparency dashboard.
8. Có điều khoản về bài đăng bị từ chối, campaign không chạy được, hoàn tiền dịch vụ do lỗi operator, budget chưa giải ngân và tranh chấp.
9. Công bố rõ điều khoản referral 5%, định nghĩa thành công, trường hợp gian lận/clawback, quyền sử dụng hoa hồng để bid, lịch rút thủ công ngày 01-10, ngưỡng rút, phí chuyển tiền/FX và nghĩa vụ thuế tùy thị trường; không gọi referral program là đầu tư hoặc bảo đảm thu nhập.
10. Không công khai danh tính người được giới thiệu, thông tin payout, số tài khoản ngân hàng hay dữ liệu hành vi định danh. Attribution và đo click/view phải có thông báo quyền riêng tư và giới hạn lưu trữ phù hợp.

---

## 11. Phases và Definition of Done

### Phase 0: Repo audit + ADR + provider feasibility

- [ ] Xác định repo, stack, database, hosting, auth, secret store, CI/test setup; không tự tạo repo mới khi chưa kiểm tra.
- [ ] Tạo `docs/ADR/` ghi quyết định bid duration, FX, quote, budget policy, video format, supported channels.
- [ ] Chạy sandbox PayPal Business và SePay Payment Gateway; kiểm tra merchant eligibility cho mô hình quảng bá trả phí.
- [ ] Kiểm tra Zernio social comment/Ads endpoints và scope của các tài khoản được kết nối; đánh dấu theo từng channel `supported | requires_setup | blocked`.
- [ ] Chốt access policy cho Grok Bot, Jev/TypeSafe integration và Cloud Browser.
- [ ] Viết plan/migrations trước khi thực hiện thao tác production.

### Phase 1: Product + MCP + public listing

- [ ] `/mcp` OAuth hoạt động trên client mục tiêu.
- [ ] Chỉ MCP tạo/sửa/submit sản phẩm; web không có endpoint công khai tạo sản phẩm và không bị bypass bằng API REST.
- [ ] Page builder schema và renderer an toàn, preview/publish versioned.
- [ ] Public BXH Daily/Weekly/Monthly, realtime ordering, free products sau paid.
- [ ] Basic analytics card impressions/click/outbound; chống bot/dedup sơ bộ.
- [ ] Referral code/link có attribution 1 người được giới thiệu -> 1 người giới thiệu; chống self-referral và account trùng.
- [ ] Ranking khi bid bằng nhau/0: referral successful DESC, filtered clicks DESC, filtered views DESC; kiểm thử snapshot tái lập được.

### Phase 2: Payments + bidding + ledger

- [ ] PayPal sandbox: order -> approval -> capture -> verified webhook -> exactly-one contribution.
- [ ] SePay sandbox: QR/checkout -> verified IPN -> exactly-one contribution.
- [ ] Bid bị vượt vẫn giữ contribution và có thể bid tiếp; transaction race tests pass.
- [ ] Rolling expirations 1/7/30 ngày, không kéo dài contributions cũ khi nộp mới.
- [ ] Hai currency/FX quote có số tiền nhất quán, đối soát provider và DB.
- [ ] Replay/duplicate/out-of-order events, refund/chargeback, timeout được kiểm thử.
- [ ] Hoa hồng 5% cho successful referral đủ điều kiện, chống ghi nhận trùng; pending/available/clawback được phản ánh trên double-entry ledger.
- [ ] Ví hoa hồng chi được bid toàn phần hoặc kết hợp PayPal/SePay; reserve, release, settle exactly once; không tiêu ví và tiền ngoài trùng nhau.
- [ ] Payout request khóa số dư, xuất monthly batch, chuyển khoản thủ công ngày 01-10, nhập proof, reconcile; không có nút tự chuyển tiền ngoài ngân hàng.
- [ ] Chưa đủ điều kiện chính sách merchant thì **disable live payments**, vẫn có sandbox.

### Phase 3: 03:12 snapshots + cohorts + media

- [ ] Freeze 3 BXH hằng ngày tại đúng cutoff local, idempotent kể cả retry/job chạy muộn.
- [ ] Snapshot immutable, định danh URL cố định, top 10 và lịch sử thứ hạng.
- [ ] RevenueCohort 80% tạo đúng một lần/contribution, không chi trùng bid tuần/tháng; referral commission 5% nếu đủ điều kiện, operator giữ residual không âm; wallet bid được hạch toán nội bộ đúng nguồn tiền.
- [ ] Tạo 3 motion videos từ dữ liệu snapshot, lưu content hash và trạng thái QA.
- [ ] Đăng X/Facebook/YouTube qua Zernio; URL chính xác theo snapshot; comment có link hoặc fallback có trạng thái rõ.

### Phase 4: Ads operator + transparency

- [ ] Grok Bot nhận events, lập kế hoạch trong giới hạn tài chính.
- [ ] Zernio Ads adapter thực hiện tạo/chỉnh/giám sát chiến dịch khi account được cấp quyền.
- [ ] Ad flights 1/7/30 ngày có budget caps, không cross-spend; tạm dừng nếu reconciliation thất bại.
- [ ] Thu dữ liệu theo giờ từ provider; screenshot bổ sung; public dashboard thể hiện `as_of_at` và source.
- [ ] Có operator kill switch, audit log, DLQ và báo cáo cuối kỳ.

### Phase 5: Go-live checklist

- [ ] Legal/merchant acceptance, ads account readiness, Terms/Privacy/Refund/Content/Ads Disclosure đã được phê duyệt.
- [ ] E2E payment không dùng dữ liệu giả đã test với tiền thật quy mô nhỏ khi được cho phép.
- [ ] Hard spending limits, alerts, bank reconciliation và finance dashboard hoạt động.
- [ ] Legal/tax/payout disclosure và account verification cho chương trình referral, hướng dẫn rút tiền thủ công; owner đã duyệt policy 5% (giao dịch đầu so với lifetime).
- [ ] Domain/DNS/cert, OAuth redirect URI, webhooks HTTPS production.
- [ ] Backup/restore, monitoring, SLO, failure runbooks và incident response.
- [ ] **Explicit owner approval** trước khi bật nhận tiền thật hoặc tạo Ads campaigns trả phí; không tự bật ở phase trước.

---

## 12. Acceptance scenarios bắt buộc

| ID | Scenario | Expected |
|---|---|---|
| A01 | Free product published via MCP | Được duyệt, hiển thị cuối BXH, có thể nhận impressions |
| A02 | Call REST trực tiếp để tạo product | Bị từ chối, không bypass MCP/auth |
| A03 | A bid $10, B bid $20, A bid thêm $11 | A đứng trên với active bid $21 |
| A04 | #11 đã trả tiền nhưng không lọt Top 10 | Không được lên video, không refund vì mất hạng, vẫn hiện trên listing |
| A05 | Hai webhook cùng `provider_event_id` hoặc same payment | Chỉ 1 contribution + 1 revenue allocation |
| A06 | User mở success redirect nhưng chưa capture/IPN | Không tăng rank |
| A07 | Refund/chargeback sau khi bid đã active | Adjustment có log, trạng thái xử lý; không double counting |
| A08 | Weekly $100 được xác nhận trước 03:12 | Cohort tuần hiện tại có $100 revenue một lần, quỹ Ads $80 theo chính sách; rank có thể xuất hiện ở nhiều snapshot |
| A09 | Weekly bid ngày hôm qua vẫn active, hôm nay không có bid mới | Snapshot hôm nay có thể giữ Top 10 nhưng quỹ Ads **mới** từ bid cũ bằng $0 |
| A10 | 03:12 job chạy 2 lần hoặc chạy trễ | Vẫn đúng 1 snapshot/board/cutoff và 1 allocation |
| A11 | Bid xác nhận 03:12:01 | Live rank cập nhật ngay, thuộc cohort ngày hôm sau |
| A12 | Bid cũ hết hạn khi có bid mới hơn | Chỉ khoản cũ mất hiệu lực; khoản mới vẫn active |
| A13 | Product chứa prompt injection yêu cầu đổi budget/ad accounts | Jev/TypeSafe deny; hard cap không bị bypass; lưu log |
| A14 | Grok muốn chi thêm vượt `ad_fund` hoặc chuyển tiền giữa boards | API deny dù Grok yêu cầu |
| A15 | Video đăng thành công nhưng đăng comment lỗi | Không đăng video trùng; retry comment hoặc fallback, trạng thái partial |
| A16 | Không có đủ ngân sách để chạy kênh quảng cáo | Flight giữ unallocated/pauses, không dùng quỹ kỳ khác |
| A17 | Sản phẩm bị ban sau snapshot | Không sửa âm thầm snapshot; publication/moderation state có dấu vết |
| A18 | Người không sở hữu sản phẩm gọi tool bid/edit trái quyền | 403; không lộ private dữ liệu |
| A19 | Giả mạo PayPal/SePay webhook | Bị từ chối trước khi ghi ledger hoặc rank |
| A20 | Dùng test mode | Không thể khởi tạo paid ads hoặc charge live nếu chưa bật live flag/owner approval |
| A21 | Cùng active bid, A có 3 successful referrals, B có 2 | A đứng trên B, dù B có nhiều click hơn |
| A22 | A bid $10 có 0 referral, B bid $9 có 100 referrals | A vẫn trên B (pay-to-win ưu tiên tuyệt đối) |
| A23 | Hai sản phẩm free, cùng số referrals, A có filtered clicks cao hơn B | A đứng trên, không dựa raw bot traffic |
| A24 | Cùng bid/referrals/clicks; A có valid views cao hơn | A đứng trên, theo rollup/version thống nhất |
| A25 | Một referred user đặt 5 bid thành công | Chỉ tăng `successful_referral_count` của referrer **một**, không tăng thành 5 |
| A26 | Referral tự đăng ký tài khoản phụ/đặt bid bị đánh dấu fraud | Không ghi successful referral hoặc commission; có decision log, quy trình khiếu nại |
| A27 | Referred buyer mua bid bằng cash hợp lệ, policy first-bid 5% | Commission được accrue đúng một lần, chuyển available sau hold; quỹ Ads vẫn 80%, operator nhận residual |
| A28 | User dùng toàn bộ commission wallet để bid | Exactly-one contribution, wallet debit balanced, không tạo cash receipt ảo, ads allocation không double-spend |
| A29 | User dùng một phần wallet, PayPal/SePay phần còn lại thất bại | Không tăng bid, wallet reservation được release idempotently |
| A30 | User đồng thời bấm rút $20 và bid ví $20 | Chỉ một hành động reserve được $20, không âm và không double spend |
| A31 | Rút tiền thành công ngày 01-10 | Cần bằng chứng chuyển khoản/đối soát trước `paid`, không để agent giả lập xác nhận |
| A32 | Refund/chargeback của bid tạo referral commission | Chạy clawback/hold, không xóa audit history; xử lý khi đã paid theo policy |
| A33 | Một sản phẩm có score tăng ngay trước 03:12 | Snapshot dùng score và policy version tại cutoff; job retry cho kết quả xác định |

---

## 13. Các giả định mở, phải ghi trong ADR và cấu hình

Những mục này **chưa phải yêu cầu người dùng trả lời ngay**. Coding agent được làm theo mặc định an toàn, triển khai dưới feature flags và trình bày lại trước go-live:

1. **Mốc hiệu lực bid:** mặc định tính từ lúc payment confirmed, rolling 24h/7d/30d; không neo về 03:12.
2. **Monthly:** mặc định 30 × 24 giờ, không phải tháng lịch. Có thể đổi khi owner quyết định.
3. **Giá trị bid tối thiểu:** chỉ dùng giá sandbox; giá production và bước nhảy tối thiểu để cấu hình.
4. **Tiền tệ:** PayPal ưu tiên USD, SePay VND; dùng USD-equivalent rank units với tỷ giá khóa trong quote, có display minh bạch.
5. **Định nghĩa `eligible_revenue`:** mặc định sau refund/tax withheld, trước phí xử lý, nhưng cách hiển thị cam kết 80% cần legal/owner approval.
6. **Thời gian phục vụ ads:** flight mới bắt đầu ở cutoff 03:12 tương ứng; không cộng tiền bid cũ vào cohort mới.
7. **Số lượng video khi doanh thu cohort = 0:** mặc định vẫn có snapshot, video organic là tùy cấu hình; không tạo campaign có ngân sách $0.
8. **Liên kết trong comments:** cố gắng comment/pin; nếu platform không hỗ trợ, dùng post caption/URL snapshot/hướng dẫn phù hợp, ghi trạng thái thay vì claim đã comment.
9. **Giao diện trực quan:** website public có thể có theme system/light/dark, trang nội dung và dữ liệu kỹ thuật hỗ trợ tiếng Việt/Anh; không làm UI builder tùy ý.
10. **OpenAI Ads:** channel tùy chọn chỉ bật khi Zernio/API/account có hỗ trợ thực tế, không mặc định tài khoản vận hành đã được cấp quyền.
11. **Tài khoản merchant:** PayPal Business tại VN được tài liệu PayPal giới thiệu; việc chấp nhận mô hình cụ thể phải qua onboarding/approval thực tế. SePay tương tự.
12. **Referral eligibility:** định nghĩa `successful referral` là một referred account có qualifying paid bid sau thời gian chống fraud/hold; mặc định **chỉ bid đầu tiên** hưởng commission 5%, không tự mở lifetime earnings khi owner chưa duyệt.
13. **Referral attribution:** signed referral code, một referrer mỗi user, TTL configurable, no self-referral; đối soát tài khoản liên quan và tránh referral loops.
14. **Click/view tie breaker:** `valid unique clicks` DESC rồi `valid unique views` DESC trong rolling 30 ngày, dữ liệu chống bot có rollup/version. Owner có thể duyệt công thức khác trước production.
15. **Payout thủ công:** ngày 01-10 mỗi tháng là cửa sổ chuyển khoản, đề xuất hold 30 ngày và minimum payout configurable; chỉ số dư available, không pending/reserved.
16. **Commission wallet:** tiền hoa hồng đã được dành riêng có thể chuyển nội bộ thành bid, không trả commission đệ quy trên phần bid tài trợ bằng ví. Giữ double-entry / reconciliation; không chuyển P2P.

## 14. Khóa phạm vi / tiêu chí dừng

Dừng và báo cáo rõ thay vì lặng lẽ làm sai nếu gặp một trong những điều kiện:

- PayPal hoặc SePay không chấp thuận mô hình kinh doanh khi onboarding.
- Không thể bảo đảm payment-to-bid exactly once; ledger không balance; snapshot/ads fund có nguy cơ đếm trùng.
- Không thể ngăn operator/agent vượt hard spending cap.
- Cơ chế xác thực MCP/owner permissions không đủ an toàn.
- Zernio/Ads account bị chặn, không có quyền tạo campaign; phải degrade thành organic-only, **không tiếp tục nhận bid với lời hứa Ads chưa thể thực hiện**.
- Không thể công bố rõ luật all-pay và policy xử lý hoàn tiền/chi tiêu không sử dụng.
- Không thể bảo đảm referral commission được bảo chứng bằng tiền, cash/wallet settlement không double spend, hoặc rút tiền thủ công có chứng từ.
- Không thể chống các trường hợp referral sybil/click farm tới mức tối thiểu; tạm vô hiệu hóa tính referral/click/view vào ranking cho đến khi kiểm thử và hoàn tất policy review.

## 15. Cấu trúc đầu ra coding agent phải bàn giao

- Code + migrations + seed data + `.env.example` (không có secrets) + deployment manifests.
- `docs/ARCHITECTURE.md` mô tả domain, ranh giới trust, data flow.
- `docs/ADR/*.md` cho mọi giả định ảnh hưởng tiền/timing/quyền.
- `docs/MCP_TOOLS.md` gồm schemas và OAuth scopes.
- `docs/PAYMENTS.md` gồm PayPal/SePay sandbox/live, verification, refunds, reconciliation, test vectors.
- `docs/AD_BUDGET.md` gồm formula, ledgers, dashboard, per-cohort flight.
- `docs/REFERRALS_AND_PAYOUTS.md` gồm attribution, successful referral definition, 5% policy, wallet ledger, payout window 01-10, tax/privacy/fraud rules, dispute/clawback và test vectors.
- `docs/OPERATOR_RUNBOOK.md` gồm Grok Bot + Zernio CLI/MCP/API + kill switch, failure/recovery.
- Automated unit/integration/E2E tests cho A01-A33; CI gating; threat model và load test kết quả.
- Demo end-to-end từ agent đăng sản phẩm đến bid qua payment sandbox, referral -> hoa hồng -> ví bid / payout request, BXH, 03:12 snapshot, video/social mocked provider, ad spend mock, dashboard.
- `IMPLEMENTATION_REPORT.md` gồm: đã làm, chưa làm, blocked, feature flags, kết quả test, rủi ro còn lại, quyết định cần duyệt trước production.

---

## Changelog v1.1 (08/11/2026)

- **Đã chốt bởi owner:** referral commission 5%/successful referral, ranking ưu tiên số referral thành công rồi clicks/views khi active bid bằng nhau hoặc = 0, ví hoa hồng dùng bid, yêu cầu rút và chuyển khoản thủ công ngày 01-10 mỗi tháng.
- **Được suy ra để không phá pay-to-win:** tổng active bid vẫn là khóa xếp hạng cao nhất, referral chỉ dùng khi hòa bid, clicks/views là phá hòa tiếp theo.
- **Chưa chốt, triển khai qua cấu hình/ADR trước khi live:** phạm vi commission (first bid hay recurring), cách xác minh referral thành công, cửa sổ attribution, thời gian hold, ngưỡng rút, thuật toán click/view và chống bot. Không nhầm những mặc định đề xuất này với quyết định của owner.
- **Đã thêm:** tài chính 80% Ads + tối đa 5% commission, wallet settlement, schema/event/MCP, payout manual, fraud guardrails và A21-A33.

---

## 16. Nguồn kỹ thuật đã kiểm tra (08/11/2026)

**Các liên kết sau hỗ trợ khả năng của provider; không tự xác nhận quyền truy cập của một merchant/account cụ thể.**

1. PayPal Business tại Việt Nam: https://www.paypal.com/vn/business/getting-started
2. PayPal Orders API integration: https://developer.paypal.com/whats-an-order/
3. PayPal checkout webhooks và capture completion: https://developer.paypal.com/payment-methods/webhooks/
4. PayPal webhook signature security: https://developer.paypal.com/api/rest/webhooks/rest/
5. PayPal idempotency header: https://developer.paypal.com/api/make-api-requests
6. SePay Payment Gateway tổng quan: https://developer.sepay.vn/vi/cong-thanh-toan/gioi-thieu
7. SePay Gateway IPN verification: https://developer.sepay.vn/vi/cong-thanh-toan/IPN
8. SePay API sandbox/production: https://developer.sepay.vn/vi/cong-thanh-toan/API/tong-quan
9. SePay Bank Webhook HMAC (nếu dùng phương án khác): https://developer.sepay.vn/vi/sepay-webhooks/xac-thuc
10. Zernio cross-platform Ads: https://zernio.com/social-media-ads
11. Zernio Ads Meta example: https://docs.zernio.com/platforms/meta-ads/campaigns
12. Zernio YouTube firstComment: https://docs.zernio.com/platforms/youtube
13. MCP authorization/remote server: https://py.sdk.modelcontextprotocol.io/run/authorization/
14. MCP protocol versions: https://ruby.sdk.modelcontextprotocol.io/protocol-versions/

**Quy tắc cuối:** *AI có thể vận hành quảng cáo và chuẩn bị trả hoa hồng, nhưng tiền và quyền lợi của khách phải được kiểm soát bằng code, transaction, chữ ký và audit. Chuyển khoản hoa hồng theo lịch là thao tác thủ công có đối soát.*
