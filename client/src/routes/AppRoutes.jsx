import { Link, Route, Routes } from 'react-router-dom';
import HomePage from '../pages/HomePage';
import PlaceholderPage from '../pages/PlaceholderPage';

const pages = [
  ['Login', '/login'],
  ['Register', '/register'],
  ['Events', '/events'],
  ['Profile', '/profile'],
  ['Bookings', '/bookings'],
  ['Admin dashboard', '/admin'],
];

export default function AppRoutes() {
  return (
    <>
      <nav className="navigation">
        <Link to="/">Eventra</Link>
        {pages.map(([label, path]) => <Link key={path} to={path}>{label}</Link>)}
      </nav>
      <main className="page">
        <Routes>
          <Route path="/" element={<HomePage />} />
          {pages.map(([label, path]) => (
            <Route key={path} path={path} element={<PlaceholderPage title={label} />} />
          ))}
          <Route path="*" element={<PlaceholderPage title="Page not found" />} />
        </Routes>
      </main>
    </>
  );
}

