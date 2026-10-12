# Msongola Results Notification System

Backend service that receives approved learner results from the school's internal results system and prepares SMS messages for the learners' registered parents or guardians. Parents do not have system accounts.

## Development setup

1. Start MySQL or MariaDB.
2. For a new database, import `Database/schema.sql`, then `Database/seed.sql`.
3. For an existing `msongola_results` database, take a backup before applying migrations. Run `Database/migration_result_integration.sql` if the results integration migration has not yet been applied, then run `Database/migration_staff_account_roles.sql` once to allow Academic Master staff accounts while preserving any legacy parent login rows. Run `Database/migration_africas_talking_sms.sql` once for SMS worker locking, `Database/migration_africas_talking_delivery_reports.sql` once to record provider delivery receipts, and `Database/migrations/20260601_admission_number_sequences.sql` to initialize system-assigned admission numbers. Do not run one-time migrations twice, except the admission-number sequence migration, which is safe to rerun.
4. Copy `Backend/.env.example` to `Backend/.env`; configure the database settings and set strong, private values for `JWT_SECRET` and `RESULTS_INTEGRATION_KEY` (at least 32 characters each).
5. From `Backend`, run `npm install` and `npm start`. SMS delivery remains disabled until explicitly configured.
6. Open `http://localhost:5000`.

The seeded development staff login is `admin@msongola.com` / `admin123`. Change this password before any production deployment.

## Staff roles and account administration

The `admin` role is the system operator. It can access system integration and SMS operations and is the only role allowed to create, edit, change roles/passwords, or delete staff accounts. Its overview focuses on staff accounts, SMS delivery activity, imported batch totals, and system readiness. The `academic_master` role gets a separate academic overview for learner/result/subject totals, subject performance, and approved result imports; only this role can open learner, result, and academic report pages or call the learner/result APIs. The academic overview reports the number of learners with and without at least one linked guardian contact and the overall contact coverage. Its **Review missing contacts** action opens the learner list filtered to learners without a registered contact; clearing the contact filter returns to the full register. These are registration-readiness indicators, not proof that a phone number is active or that the guardian has consented to SMS. The reports page filters result records by class, subject, term, and year, exports the selected records as an Excel-compatible UTF-8 CSV, and provides a print layout for school records. Academic Master cannot administer accounts, access SMS operations, or view provider setup guidance. Parents/guardians are contacts and never receive login accounts. The existing-database staff-role migration preserves legacy `parent` rows but excludes them from staff lists and blocks their access. The learner list can be searched by name, admission number, or class and filtered by class or guardian-contact status. Academic Master can add and edit learner records and link up to 10 guardian contacts, with international-format phone numbers and one primary contact when any are provided. Changes to a learner and their linked contacts are saved in one database transaction; removing a contact only unlinks it from that learner and does not delete historical results or the parent contact record. Administrators can refresh and filter the SMS outbox by delivery status. The **Results integration** page lists the 100 most recent batches with search and status filtering; SMS queue counts and provider configuration details are administrator-only.

Learner records are managed in the **Learners & results** workspace. The staff API supports `GET /api/students/:id`, `POST /api/students`, and `PUT /api/students/:id` for an Academic Master. New records without an explicitly supplied legacy admission number receive a unique `MSS-YYYY-NNNN` number, with the sequence restarting each calendar year; edits retain the existing admission number. Guardian phone numbers must use international format (for example, `+255712345678`); guardian contacts are optional, but exactly one must be marked primary when contacts are supplied. There is no learner-delete operation, to avoid accidentally cascading deletion of imported results.

For existing registers, use **Import CSV** in the learner workspace to download the template, select a completed CSV, review each row, and confirm the import. CSV files are limited to 2 MB and 500 learners. Required headers are `name`, `className`, and `year`; `admissionNumber` is optional. Keep a legacy admission number in that column to preserve it, or leave it blank to have the system assign one. The import confirmation reports all generated numbers. Use **Export CSV** to download the register matching the current search, class, and guardian-contact filters; the export includes admission number, learner name, class, academic year, and number of registered guardian contacts. Spreadsheet formula-like cell values are escaped to prevent them from being interpreted as formulas. Optional guardian columns use numbered groups from `guardian1Name`, `guardian1Phone`, `guardian1Relationship`, and `guardian1IsPrimary` through `guardian10...`. Set exactly one supplied guardian's `IsPrimary` field to `true`; other supplied contacts should use `false`. Leave all fields for an unused guardian blank. Phone numbers must already be in international format. The preview blocks the import if any row is invalid or if admission numbers repeat in the file. The server checks the same rules and atomically saves the complete file; a duplicate already in the database rejects the whole upload without partial changes. Importing learner contacts does not import results or send/queue SMS messages.

Before running this feature against an existing database, apply `Database/migrations/20260601_admission_number_sequences.sql`. It creates the annual sequence table and seeds each year's counter from existing `MSS-YYYY-NNNN`-format admission numbers so the next generated number does not collide.

The Academic Master-only bulk endpoint is `POST /api/students/import` with a JSON body shaped as `{ "students": [ ...learner records... ] }`. It accepts the same learner fields and guardian structure as `POST /api/students`, up to 500 records per request.

Both staff roles have a **My profile** page in the workspace navigation. It displays the signed-in staff member's name, work email, account ID, workspace, and role-specific access; passwords are never displayed. Administrators and Academic Masters can change their own password from this page by entering the current password and confirming a new password of 12–128 characters. The API is `PATCH /api/profile/password` with `currentPassword` and `newPassword`.

An administrator manages accounts from **Staff accounts** in the workspace or through `GET/POST /api/admin/users`, `PUT /api/admin/users/:id`, and `DELETE /api/admin/users/:id`. New passwords must be 12–128 characters. The account list also has a dedicated **Reset password** action for other staff accounts; it sets a temporary password without revealing it to the browser and the administrator should share it securely. The API is `PATCH /api/admin/users/:id/password` with a `password` field. Administrators must use their profile to change their own password. Account removal or role change takes effect on the next request because the API rechecks the current database account on every authenticated request. The current administrator cannot delete or demote their own account, and the system protects the last administrator.

## Backend tests

Run `npm test` from `Backend` to test the API contract, authentication gates, staff-account permissions and lifecycle, learner and guardian registration, atomic CSV/bulk registration, batch validation, Africa's Talking request formatting, response/error handling, and delivery-report processing. Provider and database dependencies are mocked during these tests; no SMS is sent.

## Approved-results integration

The internal results system should call this endpoint only after results are approved:

`POST /api/integrations/results/batches`

Send the integration key in the `X-Integration-Key` header. Keep this key on the server-to-server connection; never put it in frontend JavaScript.

```json
{
  "sourceSystem": "school-results",
  "batchId": "exam-2026-term-1-final",
  "examName": "End of Term Examination",
  "term": "Term 1",
  "year": 2026,
  "status": "APPROVED",
  "students": [
    {
      "externalStudentId": "school-student-101",
      "admissionNumber": "ST-101",
      "name": "Asha Moyo",
      "className": "Grade 8",
      "guardians": [
        {
          "name": "Mary Ndlovu",
          "phone": "+263771234567",
          "relationship": "Mother",
          "isPrimary": true
        }
      ],
      "results": [
        {
          "externalResultId": "school-result-101-math-term1-2026",
          "subject": "Mathematics",
          "score": 92,
          "grade": "A",
          "comment": "Excellent progress."
        },
        {
          "externalResultId": "school-result-101-english-term1-2026",
          "subject": "English",
          "score": 88,
          "grade": "A"
        }
      ]
    }
  ]
}
```

Before enabling live imports, send the same approved payload with `X-Integration-Dry-Run: true`. The API checks the integration key and validates the payload fields, then returns the batch ID and student, result, and guardian counts. A dry run does not check for identifiers already stored in the database, access the database, import results, or queue SMS messages. For example, save the JSON above as `approved-batch.json` and run this from a trusted server or PowerShell terminal, replacing the placeholder with the private key configured in `Backend/.env`:

```powershell
curl.exe --fail-with-body --request POST "http://localhost:5000/api/integrations/results/batches" `
  --header "Content-Type: application/json" `
  --header "X-Integration-Key: <your-private-results-integration-key>" `
  --header "X-Integration-Dry-Run: true" `
  --data-binary "@approved-batch.json"
```

Only remove the dry-run header after reviewing a successful validation response and confirming the target database and SMS settings. A normal request imports the batch and may queue messages for real guardians.

`batchId` must stay the same when retrying delivery of the same exam batch. Each `externalResultId` must be a stable, unique ID for one subject result. The service validates and transactionally imports the batch, updates learner/guardian contacts, and queues one SMS per linked guardian and learner. Repeated batches are idempotent; only `APPROVED` batches are accepted.

The local **Msongola School Result System** can send a complete approved class report to this API from its Academic Master reports page. Keep this API on port `5000` and run the school results API on port `5001`; its frontend should use `http://localhost:5001/api`. Configure the same private `RESULTS_INTEGRATION_KEY` in both backend environments and set the school results backend's `RESULTS_PARENT_API_URL=http://127.0.0.1:5000`. In the school system, generate a complete class report, run the dry-run check, then explicitly confirm an import. Dry-run validates the payload without database writes or SMS queueing.

The school results database does not currently store guardian contacts. The integration therefore sends an empty guardian list; this leaves contacts already maintained in this system unchanged. Imported results can be associated with those existing contacts and may queue SMS messages if SMS delivery is configured.

## Africa's Talking SMS delivery

The backend includes an Africa's Talking worker that checks the outbox every 15 seconds and submits queued messages individually. It is disabled by default. To test without sending real messages, configure an Africa's Talking sandbox API key and username, keep `AFRICASTALKING_ENVIRONMENT=sandbox`, and set `SMS_DELIVERY_ENABLED=true`:

```dotenv
SMS_DELIVERY_ENABLED=true
AFRICASTALKING_ENVIRONMENT=sandbox
AFRICASTALKING_USERNAME=sandbox
AFRICASTALKING_API_KEY=your-private-sandbox-api-key
AFRICASTALKING_SENDER_ID=
AFRICASTALKING_DELIVERY_TOKEN=your-private-random-token-at-least-32-characters
```

For live sending, obtain production API credentials and any required sender ID approval from Africa's Talking, set `AFRICASTALKING_ENVIRONMENT=production`, and keep the API key only in `Backend/.env` or the hosting platform's secret store. Live SMS may incur charges. Never put provider credentials in frontend code, source control, or messages shared with the school system.

Configure Africa's Talking's delivery-report callback URL in its dashboard as `https://your-public-host/api/integrations/sms/delivery-reports?token=<AFRICASTALKING_DELIVERY_TOKEN>`. Use HTTPS and keep this token private; the callback endpoint accepts Africa's Talking's `id`, `phoneNumber`, `status`, and optional `failureReason` fields as JSON or form data. The callback matches both the provider message ID and recipient number, and duplicate reports are safe to replay. A locally hosted server needs a public HTTPS URL before Africa's Talking can reach it.

`PENDING` means waiting in the local queue; `PROCESSING` means the worker is submitting the message; `SENT` means Africa's Talking accepted it; `DELIVERED` means the provider sent a successful delivery report; `FAILED` means submission or final delivery failed. Staff can retry failed messages from the SMS outbox. If a request times out or the worker is interrupted after the provider accepts a message but before the database records success, a retry may send a duplicate.

## Admin API

- `POST /api/auth/login` — staff login; only `admin` and `academic_master` roles are accepted.
- `GET /api/profile` — current authenticated staff profile.
- `GET /api/dashboard/summary` — role-specific totals: academic metrics for Academic Master; staff, SMS delivery, and import metrics for Admin.
- `GET /api/students` — learner list.
- `GET /api/results/:studentId` — learner result records.
- `GET /api/reports/summary` — subject result summary.
- `GET /api/reports/results` — Academic Master report rows; optionally filter with `year`, `className`, `subject`, and `term` query parameters.
- `GET /api/integrations/batches` — recent imported batches.
- `GET /api/sms/outbox` — administrator-only SMS messages; optionally filter with `?status=PENDING`.
- `POST /api/integrations/sms/delivery-reports?token=...` — Africa's Talking delivery report callback (not a staff endpoint).
- `POST /api/sms/outbox/:id/retry` — administrator-only retry of a failed SMS message.

Admin API routes require `Authorization: Bearer <token>`.
