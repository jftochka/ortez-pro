# Ortez-Pro CMS Auth Bridge

Cloudflare Worker, який дозволяє клієнту логінитися в Sveltia CMS через **Google акаунт**, без власного GitHub-акаунту.

## Як це працює

```
Клієнт → /cms/ → Login → [Google OAuth] → [Worker] → [GitHub App token] → CMS
```

1. Клієнт відкриває `https://ortez.com.ua/cms/` і натискає "Login"
2. Sveltia CMS відкриває попап з URL: `https://cms-auth.ortez.com.ua/auth?provider=github&...`
3. Worker перенаправляє на Google OAuth
4. Клієнт логіниться в Google (з 2FA, якщо налаштовано)
5. Google повертає на `/callback` Worker'а
6. Worker:
   - Верифікує Google ID Token (підпис проти Google JWKS)
   - Перевіряє email у allowlist
   - Генерує короткоживущий (~1 год) installation token GitHub App'а
7. Worker повертає токен у CMS через `postMessage`
8. CMS використовує токен для комітів. Усі коміти атрибутуються GitHub App'у.

**Безпека**: клієнт ніколи не має доступу до GitHub. Приватний ключ GitHub App зберігається у Cloudflare Worker secrets, ніколи не покидає сервер. Токени короткоживущі.

---

## Передумови (одноразово, ~30 хв)

- Акаунт Google (можна `@gmail.com` клієнта або ваш)
- Акаунт GitHub (ваш, як власника репо)
- Акаунт Cloudflare (безкоштовно): https://dash.cloudflare.com/sign-up

---

## Крок 1: Створення Google OAuth Client

1. Відкрийте https://console.cloud.google.com/
2. Створіть новий проєкт: **Select a project → New Project**
   - Name: `Ortez-Pro CMS`
   - Натисніть **Create**
3. Перейдіть до **APIs & Services → OAuth consent screen**
   - User Type: **External** → **Create**
   - App name: `Ortez-Pro CMS`
   - User support email: ваш email
   - Developer contact: ваш email
   - **Save and Continue** (наступні кроки можна пропустити)
   - На останньому кроці натисніть **Back to Dashboard**
4. **Test users** (важливо для External режиму): додайте Gmail клієнта в Test Users
5. Перейдіть до **APIs & Services → Credentials → Create Credentials → OAuth Client ID**
   - Application type: **Web application**
   - Name: `Ortez-Pro CMS Worker`
   - Authorized redirect URIs: тимчасово залиште `https://example.com/callback` -- оновимо після деплою Worker'а
   - **Create**
6. **Збережіть** в надійному місці:
   - `Client ID` (виглядає як `123456-abc...apps.googleusercontent.com`)
   - `Client secret` (виглядає як `GOCSPX-xxx...`)

---

## Крок 2: Створення GitHub App

1. Відкрийте https://github.com/settings/apps/new
2. Заповніть:
   - **GitHub App name**: `Ortez-Pro CMS Bot`
   - **Homepage URL**: `https://ortez.com.ua`
   - **Webhook**: зніміть галочку **Active** (вебхуки нам не потрібні)
3. **Repository permissions**:
   - **Contents**: `Read and write` (для комітів вмісту)
   - **Pull requests**: `Read and write` (для editorial workflow)
   - **Metadata**: `Read-only` (вмикається автоматично)
4. **Where can this GitHub App be installed?**: **Only on this account**
5. Натисніть **Create GitHub App**
6. На сторінці App'у:
   - Запам'ятайте **App ID** (число, наприклад `123456`)
   - Внизу натисніть **Generate a private key** -- завантажиться файл `.pem`. Збережіть його надійно!
7. Встановіть App на репо: ліва панель → **Install App** → ваш акаунт → **Only select repositories** → виберіть `ortez-pro` → **Install**
8. Після встановлення URL виглядає так: `https://github.com/settings/installations/12345678`. Число в кінці -- це **Installation ID**. Запам'ятайте.

---

## Крок 3: Деплой Cloudflare Worker

### 3a. Підготовка

```bash
# В корені проєкту ortez-pro
cd cms-auth-worker

# Встановлення Wrangler (CLI Cloudflare)
npm install
```

### 3b. Логін у Cloudflare

```bash
npx wrangler login
```

Відкриється браузер → погодьтесь.

### 3c. Деплой Worker'а

```bash
npx wrangler deploy
```

Після успіху Wrangler виведе URL Worker'а, наприклад:
```
https://cms-auth.ortez.com.ua
```

**Запам'ятайте цей URL** -- знадобиться у наступних кроках.

### 3d. Налаштування секретів

Виконайте по одній команді (Wrangler запитає значення):

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
# вставте Client ID з Кроку 1

npx wrangler secret put GOOGLE_CLIENT_SECRET
# вставте Client secret з Кроку 1

npx wrangler secret put GITHUB_APP_ID
# вставте App ID (число) з Кроку 2

npx wrangler secret put GITHUB_APP_INSTALLATION_ID
# вставте Installation ID (число) з Кроку 2

npx wrangler secret put GITHUB_APP_PRIVATE_KEY
# вставте ВЕСЬ вміст .pem файлу (включно з рядками BEGIN/END)
# Wrangler підтримує багаторядковий ввід -- після останнього рядка натисніть Ctrl+D

npx wrangler secret put ALLOWED_EMAILS
# email клієнта, наприклад: client@gmail.com
# Якщо кілька -- через кому без пробілів: a@gmail.com,b@gmail.com

npx wrangler secret put ALLOWED_DOMAINS
# вставте: ortez.com.ua,localhost,127.0.0.1
```

**Альтернативно через дашборд** (якщо термінал не зручний):
1. https://dash.cloudflare.com/ → **Workers & Pages** → `ortez-cms-auth`
2. **Settings → Variables and Secrets**
3. Натискайте **Add** для кожної змінної; для приватного ключа використовуйте **Type: Secret** і вставте PEM повністю

---

## Крок 4: Оновлення redirect URI у Google

1. Поверніться до https://console.cloud.google.com/ → **APIs & Services → Credentials**
2. Відкрийте ваш OAuth Client
3. **Authorized redirect URIs → Add URI**:
   ```
   https://cms-auth.ortez.com.ua/callback
   ```
4. **Save**

---

## Крок 5: Оновлення `static/cms/config.yml`

Відредагуйте `static/cms/config.yml` -- замініть верхню частину `backend:` на:

```yaml
backend:
  name: github
  repo: jftochka/ortez-pro
  branch: main
  base_url: https://cms-auth.ortez.com.ua
  auth_endpoint: auth
```


Закомітьте і запушіть. GitHub Actions перебудує сайт.

---

## Крок 6: Тестування

1. Відкрийте https://ortez.com.ua/cms/
2. Має з'явитись кнопка логіну
3. Клік → відкриється Google OAuth
4. Логіньтесь Gmail-акаунтом, який в `ALLOWED_EMAILS`
5. Має повернутись у CMS зі словами "Welcome" і всіма колекціями українською

### Якщо щось не працює

```bash
# Дивитись логи Worker'а в реальному часі
npx wrangler tail
```

Подивіться, що бачите в логах при логіні. Часті помилки:

| Помилка | Причина | Рішення |
|---|---|---|
| "Доступ заборонено: Домен ... не в списку дозволених" | `ALLOWED_DOMAINS` не містить домен | `wrangler secret put ALLOWED_DOMAINS` з правильним списком |
| "Email ... не має дозволу на вхід" | Email не в `ALLOWED_EMAILS` | Додайте email або змініть на правильний |
| "Помилка обміну токена з Google: redirect_uri_mismatch" | Redirect URI у Google не співпадає з Worker URL | Крок 4: оновіть Authorized redirect URIs |
| "Помилка GitHub App: ... 401" | App ID, Installation ID або приватний ключ невірні | Перевірте всі три секрети |
| "Помилка GitHub App: ... 403" | App не встановлено на репо | Поверніться до Кроку 2 крок 7 |
| Білий екран на /cms/ | `base_url` у config.yml невірний | Перевірте URL Worker'а в config.yml |

---

## Як додати ще одну людину пізніше

Просто оновіть `ALLOWED_EMAILS`:

```bash
npx wrangler secret put ALLOWED_EMAILS
# введіть: owner@gmail.com,manager@gmail.com,assistant@gmail.com
```

Зміни набудуть чинності за ~10 секунд.

## Як заблокувати когось

Видаліть email зі списку `ALLOWED_EMAILS` (так само, через `wrangler secret put`). Поточні токени діятимуть до закінчення (~1 год), нових клієнт не отримає.

## Як перевірити, хто заходив

```bash
npx wrangler tail
```

Або в дашборді: **Workers & Pages → ortez-cms-auth → Logs**.

---

## Архітектурні нотатки

- **Worker stateless**: не зберігає сесій, не має БД. Кожен запит -- незалежний.
- **Токени короткоживущі**: GitHub App installation tokens живуть ~1 годину. Після цього клієнт має перелогінитись.
- **Editorial workflow**: всі зміни через PR. Клієнт не може напряму закомітити в `main` -- це додатковий захист.
- **Cloudflare лімити (безкоштовний tier)**: 100 000 запитів на день. Більш ніж достатньо для CMS-сценарію (~30 запитів на одну сесію редагування).
- **Атрибуція комітів**: всі коміти автора `Ortez-Pro CMS Bot[bot]`. Реальний автор видно в історії змін через email Google аккаунту в логах Worker'а (якщо потрібен аудит).

## Оновлення Worker'а

Якщо змінили код у `src/index.js`:

```bash
cd cms-auth-worker
npx wrangler deploy
```

Деплой займає ~5 секунд. Існуючі сесії продовжать працювати.
