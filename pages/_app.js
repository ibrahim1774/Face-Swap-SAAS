import Script from 'next/script';

import '../styles/globals.css';
import AppHead from '../components/AppHead';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import MetaPixel from '../components/MetaPixel';
import TikTokPixel from '../components/TikTokPixel';
import ClarityTracker from '../components/ClarityTracker';

export default function App({ Component, pageProps }) {
  return (
    <>
      <AppHead />
      <Script src="https://accounts.google.com/gsi/client" strategy="afterInteractive" />
      <MetaPixel />
      <TikTokPixel />
      <ClarityTracker />
      <Navbar />
      <Component {...pageProps} />
      <Footer />
    </>
  );
}
