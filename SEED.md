Shifting to a REST API approach keeps the entire deployment cleanly within the realm of software and IT operations, completely avoiding any need to mess with physical hardware or manual file routing.

Here is the updated master blueprint tailored for the REST API integration. You can copy and paste this directly to your coding agent.

---

# Master Project Blueprint: Internal TV Broadcast Scheduler (On-Premise / REST API)

## 1. System Overview & Objective

Build an internal, web-based TV scheduling automation tool for a government broadcast network. The system must operate **entirely on-premise as a self-contained software deployment**. It will automatically ingest media files from local or mounted storage, auto-generate weekly schedules based on fixed block templates, calculate content queues using strict business rules, and provide a "Draft / Review" interface. Once approved by an admin, the system will push the generated playlists directly to 6 instances of **Softron OnTheAir Video** via their respective **REST APIs**.

## 2. Technology Stack Definition (Portable, Non-Containerized, Mac-Native Stack)

Agent, you must strictly adhere to the following stack. The whole application must live in a single self-contained project folder that can be copied via USB drive onto a Mac and run with minimal setup (no Docker, no build step required to run) — target platform is **macOS**, since that's where Softron OnTheAir Video itself runs:

* **Orchestration:** None. No Docker/Docker Compose. The backend process is started directly (e.g. `node server.js` or a simple launch script), reading config from a local file.
* **Frontend / UI:** Plain **HTML, CSS, and vanilla JavaScript** — no framework, no bundler, no build step. Served as static files directly by the backend.
* **Database:** **SQLite**. A single `.sqlite` file stored in the project folder (e.g. `./data/scheduler.sqlite`), so the entire app + data travels together on a USB copy.
* **Backend API & Cron Engine:** A local Node.js (Express/Fastify) or Python (FastAPI) service. This handles API routes, serves the static frontend, runs SQLite queries, drives the internal cron scheduling engine, and makes HTTP client requests to the Softron REST APIs.
* **Ingestion & Processing Worker:** A local script (same process or a child process) utilizing `ffmpeg`/`ffprobe` (installed on the Mac, e.g. via Homebrew) to scan mounted/local media directories, extract metadata, and update the SQLite database.

## 3. Database Schema (SQLite)

Agent, initialize the SQLite database (`scheduler.sqlite`) with the following relational schema. Ensure foreign key constraints are enabled (`PRAGMA foreign_keys = ON;`). Note the addition of network configuration in the `ChannelType` table:

* **ChannelType:** `id` (INTEGER PRIMARY KEY), `name` (TEXT), `is_active` (BOOLEAN), `api_ip` (TEXT), `api_port` (INTEGER). *(Used to target the correct Softron instance).*
* **ShowType:** `id` (INTEGER PRIMARY KEY), `name` (TEXT), `paths` (JSON/TEXT array of mounted local directories), `is_educational` (BOOLEAN).
* **Resource:** `id` (INTEGER PRIMARY KEY), `name` (TEXT), `file_path` (TEXT, absolute local mount path), `duration` (INTEGER, seconds), `subject` (TEXT), `chapter` (INTEGER, 0 if single), `is_filler` (BOOLEAN), `audience_rating` (INTEGER).
* **BlockTemplate:** `id` (INTEGER PRIMARY KEY), `channel_id` (INTEGER FK), `name` (TEXT), `weekday` (TEXT, Mon-Sun), `start_time` (TEXT), `end_time` (TEXT), `target_subject_id` (INTEGER).
* **ScheduledBlock:** `id` (INTEGER PRIMARY KEY), `template_id` (INTEGER FK), `target_date` (TEXT, YYYY-MM-DD), `status` (TEXT, 'draft', 'approved', 'exported').
* **ScheduleItem:** `id` (INTEGER PRIMARY KEY), `block_id` (INTEGER FK), `resource_id` (INTEGER FK), `play_order` (INTEGER), `is_manual_override` (BOOLEAN).
* **PlayHistory:** `id` (INTEGER PRIMARY KEY), `resource_id` (INTEGER FK), `channel_id` (INTEGER FK), `played_at` (DATETIME).

## 4. Core System Modules & Logic Rules

### Module A: The Auto-Generation Engine (Local Cron Service)

Triggered weekly via a local node-cron or background task (e.g., every Thursday) to create a **Draft Schedule**.

1. **Template Roll-Forward:** Query all active `BlockTemplates` and instantiate them as `ScheduledBlocks` for the upcoming 7 days with status `'draft'`.
2. **Content Population Engine:** For each block, populate `ScheduleItems` based on content type:
* **Lessons & Series (Fixed Loops):** Query `PlayHistory`. Select the next sequential `Resource` where `chapter = last_played + 1`.
* **Movies (Random + Cooldown):** Select randomly, applying a dynamic cooldown: `Cooldown Days = Total available movies / 2`.
* **TV Episodes:** Weekdays @ 18:00 act as random movie fillers (respecting cooldown). Sundays query for the absolute latest episode added (highest chapter/creation date on the local disk) and explicitly schedule it.


3. **Filler Knapsack (Precision Fitting):**
* Target overrun: exactly 0s. Maximum underrun: -5s.
* Stack `Resources` where `is_filler = true` before, between, and after main shows to fill the remaining block time.



### Module B: Admin Review UI (Vanilla HTML/CSS/JS)

* **Draft Review Dashboard:** Display the auto-generated 7-day schedule in a visual timeline.
* **Manual Overrides:** Allow admins to click into a `ScheduledBlock` and reorder `ScheduleItems`, swap out a specific movie, or manually add/remove fillers.
* **Validation Alerts:** If an admin manually alters a block, the UI must recalculate the duration in real-time. If it violates the -5s/0s tolerance, display a strict UI warning blocking approval until fixed.
* **Approval Workflow:** A button to transition the week's blocks from `'draft'` to `'approved'`.

### Module C: OnTheAir Video REST API Integrator

* **Trigger:** Executed locally once a day (or upon admin clicking "Push to Air" in the UI), querying all `'approved'` blocks for the target day.
* **Targeting:** The system will loop through the scheduled blocks, read the associated `ChannelType` to get the `api_ip` and `api_port`, and construct the correct endpoint URL (e.g., `http://<api_ip>:<api_port>/api/v1/...`).
* **Payload Construction:** Map the `ScheduleItems` (specifically the `file_path` and `duration`) into the required JSON payload structure. *(Note for Agent: I will provide the exact Softron OnTheAir Video REST API documentation in a follow-up prompt so you can build the specific HTTP POST/PUT requests).*

## 5. Folder & File Layout (Portable / USB-Copyable)

Agent, structure the project as a single top-level folder (no containerization) so the whole app — code, dependencies, and data — can be copied to a USB drive and run on any Mac:

* `./data/scheduler.sqlite` — the persistent SQLite database file, stored inside the project folder.
* `./media/` (or a configurable path to an external/mounted media volume, e.g. an attached drive) — read-only access for `ffprobe` to scan the media libraries. Do not assume a fixed OS path; make the media root(s) configurable per `ShowType`.
* `./public/` (or similar) — the static HTML/CSS/JS frontend served directly by the backend process.
*(Note: No export volume is required as the application communicates directly via HTTP with the OTAV instances.)*
