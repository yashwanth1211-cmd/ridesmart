# 🚌 RideSmart

AI-Based Smart Public Transportation Platform for Real-Time Bus Tracking,
ETA Prediction and Crowd-Aware Route Planning.

## 🌍 SDG Alignment
- **SDG 11:** Sustainable Cities and Communities
- **SDG 9:** Industry, Innovation and Infrastructure
- **SDG 10:** Reduced Inequalities (accessibility information)

## 📌 Problem
Passengers often don't know when a bus will arrive, how crowded it is,
or which route is best. Transport authorities also lack easy insight
into demand and delays.

## 💡 Solution
RideSmart helps passengers find, track, and plan bus journeys, and gives
authorities a dashboard to understand demand.

## ✨ Features
- Live bus tracking on a map (simulated data for the demo)
- Route planning from point A to point B
- ETA prediction using a machine learning model
- Crowd level indicator (Low / Medium / High)
- Accessibility information for routes
- Transport authority dashboard

## 🛠️ Tech Stack
| Layer | Technology |
|-------|------------|
| Frontend | React |
| Backend | FastAPI (Python) |
| Database | SQLite / PostgreSQL |
| ML | Python (scikit-learn) |
| Testing | Pytest |

## 👥 Team
| Name | Role |
|------|------|
| Member 1 | Bus location + ETA prediction |
| Member 2 | Backend APIs |
| Member 3 | Frontend |
| Member 4 | Database + routes/stops |
| Member 5 | Testing + integration |

## 🚀 Getting Started
```bash
git clone https://github.com/<owner>/ridesmart.git
cd ridesmart
# backend
pip install -r requirements.txt
uvicorn main:app --reload
# frontend
cd frontend && npm install && npm start
```

## 🤝 Contributing
1. Create your own branch: `git checkout -b yourname-feature`
2. Commit your changes and push
3. Open a Pull Request into `main`

## 📄 License
MIT
