# 따릉이 이용 현황 대시보드

## 대시보드 웹호스팅 실습

`bike_station_hourly.csv`를 브라우저에서 직접 집계해 따릉이 운영 현황의 핵심 지표
2개를 보여주는 HTML·CSS·JavaScript 대시보드입니다.

## 주요 지표

| 지표 | 계산 기준 |
| --- | --- |
| 총 이용건수 | `이용건수` 열 전체 합계 |
| 운영 대여소 수 | 이용건수 합계가 1건 이상인 고유 `대여소번호` 수 |

## 파일 구성

```text
first_dashboard/
├── index.html
├── styles.css
├── app.js
├── README.md
└── data/
    └── bike_station_hourly.csv
```

`index.html`은 `README.md`와 같은 저장소 최상위 폴더에 있습니다.

## 로컬 실행

파일을 더블클릭하지 말고 이 폴더에서 웹 서버를 실행합니다.

```powershell
python -m http.server 8000
```

브라우저에서 <http://localhost:8000>으로 접속합니다.

## GitHub

- 저장소: <https://github.com/park24401859-sudo/first_dashboard>
- GitHub Pages 활성화 후 주소: <https://park24401859-sudo.github.io/first_dashboard/>

GitHub Pages는 저장소의 `main` 브랜치와 루트(`/`) 폴더를 배포 대상으로 선택하면 됩니다.
