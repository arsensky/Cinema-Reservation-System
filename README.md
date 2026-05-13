# KinoOrdo

KinoOrdo is a cinema reservation web application for browsing movies, checking showtimes, selecting seats, and creating reservations.

## Features
- Separate **Log in** and **Sign in** actions in the top-right corner
- Movie list with filtering and search
- Movie details with showtimes
- Seat selection for 3 Halls (Hall A, Hall B, and Main Hall)
- Booking history for users

## Default Movies

The app ships with these 5 local movies with their local posters inside the project:

1. Mortal Kombat II
2. The Devil Wears Prada 2
3. Michael
4. Scammers
5. Illegal. Through Mexico

## Demo account
- `user@example.com` / `User123!`

## Tech stack
- Node.js
- JavaScript
- HTML / CSS
- SQLite

## Setup & Run Instructions
1. Install Node.js 22+.
2. Open the project folder in your editor.
3. Run:

```bash
npm install
npm start
```

4. Open `http://localhost:3000`

## Project structure

```text
Cinema-Reservation-System/
├── db/
│   ├── cinema.db
│   ├── schema.sql
│   ├── seed.sql
├── public/
│   ├── app.js
│   ├── index.html
│   ├── styles.css
├── slides/
│   ├── final-presentation.pdf
├── uploads/
│   ├── posters/
│   ├── erd-diagram.png
├── package.json
├── package-lock.json
├── server.js
└── README.md
```

## Screenshots / ER Diagram

![ERD](/uploads/erd-diagram.png)

## Pitch Presentation

Slides are included in the repository:

```text
slides/final-presentation.pdf
```
